//! Native Rust AST Skeletonizer ("Skeleton Mode").
//!
//! Uses `tree-sitter` to parse source files and replace function/method
//! implementation bodies with `{ /* ... */ }` (or `...` in Python), preserving:
//! - Module/package declarations, `use` / `import` / `export` statements
//! - Type, `struct`, `enum`, `interface`, `trait`, `class` definitions and fields
//! - Function/method signatures, visibility modifiers, attributes/decorators, and doc comments
//!
//! For unsupported languages, provides an indentation/brace-aware fallback signature extractor.

use std::path::Path;
use tree_sitter::{Language, Node, Parser};

/// Determine the canonical skeletonizer language identifier from a file path or language name.
pub fn language_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "py" | "pyw" => "python",
        "go" => "go",
        "cs" => "csharp",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        _ => "other",
    }
}

fn get_tree_sitter_language(lang: &str) -> Option<(Language, bool)> {
    match lang.trim().to_ascii_lowercase().as_str() {
        "rust" | "rs" => Some((tree_sitter_rust::LANGUAGE.into(), false)),
        "typescript" | "ts" => Some((tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), false)),
        "tsx" => Some((tree_sitter_typescript::LANGUAGE_TSX.into(), false)),
        "javascript" | "js" | "jsx" => Some((tree_sitter_javascript::LANGUAGE.into(), false)),
        "python" | "py" => Some((tree_sitter_python::LANGUAGE.into(), true)),
        "go" => Some((tree_sitter_go::LANGUAGE.into(), false)),
        "csharp" | "c_sharp" | "cs" => Some((tree_sitter_c_sharp::LANGUAGE.into(), false)),
        "java" => Some((tree_sitter_java::LANGUAGE.into(), false)),
        "c" => Some((tree_sitter_c::LANGUAGE.into(), false)),
        "cpp" | "c++" | "cc" | "hpp" => Some((tree_sitter_cpp::LANGUAGE.into(), false)),
        _ => None,
    }
}

/// Returns true if `node` is a function/method/constructor declaration whose body should be elided.
fn is_callable_node(kind: &str) -> bool {
    matches!(
        kind,
        // Rust
        "function_item"
        // TS / JS
        | "function_declaration"
        | "method_definition"
        | "generator_function_declaration"
        // Python / C / C++
        | "function_definition"
        // Go
        | "method_declaration"
        // C# / Java
        | "constructor_declaration"
        | "operator_declaration"
        | "conversion_operator_declaration"
        | "local_function_statement"
    )
}

/// Extracts an AST skeleton from `content` for the given `language` (or file extension).
/// Preserves imports, types, struct/class fields, doc comments, and function signatures,
/// replacing implementation bodies with `{ /* ... */ }` (or `...` in Python).
pub fn extract_skeleton(content: &str, language: &str) -> String {
    if content.trim().is_empty() {
        return content.to_string();
    }

    let Some((ts_lang, is_python)) = get_tree_sitter_language(language) else {
        return fallback_skeleton(content);
    };

    let mut parser = Parser::new();
    if parser.set_language(&ts_lang).is_err() {
        return fallback_skeleton(content);
    }

    let Some(tree) = parser.parse(content, None) else {
        return fallback_skeleton(content);
    };

    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    collect_replacements(
        tree.root_node(),
        content.as_bytes(),
        is_python,
        &mut replacements,
    );

    if replacements.is_empty() {
        return content.to_string();
    }

    // Sort by start byte and remove any nested spans inside already-replaced bodies
    replacements.sort_by_key(|(start, _, _)| *start);
    let mut merged: Vec<(usize, usize, String)> = Vec::with_capacity(replacements.len());
    for (start, end, rep) in replacements {
        if let Some((_, prev_end, _)) = merged.last() {
            if start < *prev_end {
                continue;
            }
        }
        if start < end && end <= content.len() {
            merged.push((start, end, rep));
        }
    }

    let mut out = String::with_capacity(content.len());
    let mut cursor = 0;
    for (start, end, rep) in merged {
        if start >= cursor && content.is_char_boundary(start) && content.is_char_boundary(end) {
            out.push_str(&content[cursor..start]);
            out.push_str(&rep);
            cursor = end;
        }
    }
    if cursor < content.len() && content.is_char_boundary(cursor) {
        out.push_str(&content[cursor..]);
    }

    out
}

fn collect_replacements(
    node: Node<'_>,
    source: &[u8],
    is_python: bool,
    out: &mut Vec<(usize, usize, String)>,
) {
    let kind = node.kind();

    if is_python && kind == "function_definition" {
        if let Some(body) = node.child_by_field_name("body") {
            let (start, end, rep) = python_body_replacement(body, source);
            out.push((start, end, rep));
            return;
        }
    } else if !is_python && is_callable_node(kind) {
        if let Some(body) = node.child_by_field_name("body") {
            let bkind = body.kind();
            if bkind == "block"
                || bkind == "statement_block"
                || bkind == "compound_statement"
                || bkind == "constructor_body"
            {
                let start = body.start_byte();
                let end = body.end_byte();
                // Only collapse bodies that span multiple lines or are non-trivial (> 18 bytes)
                if end.saturating_sub(start) > 18 || source[start..end].contains(&b'\n') {
                    out.push((start, end, "{ /* ... */ }".to_string()));
                    return;
                }
            }
        }
    } else if !is_python && (kind == "lexical_declaration" || kind == "variable_declaration") {
        // Check for top-level / exported arrow functions: `export const foo = (a: number): string => { ... }`
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "variable_declarator" {
                if let Some(val) = child.child_by_field_name("value") {
                    if val.kind() == "arrow_function" || val.kind() == "function_expression" {
                        if let Some(body) = val.child_by_field_name("body") {
                            if body.kind() == "statement_block" {
                                let start = body.start_byte();
                                let end = body.end_byte();
                                if end.saturating_sub(start) > 18
                                    || source[start..end].contains(&b'\n')
                                {
                                    out.push((start, end, "{ /* ... */ }".to_string()));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_replacements(child, source, is_python, out);
    }
}

/// For a Python `block` inside `function_definition`, keep a leading docstring if present
/// and replace the remaining statements with `...`.
fn python_body_replacement(body: Node<'_>, source: &[u8]) -> (usize, usize, String) {
    let mut cursor = body.walk();
    let children: Vec<Node<'_>> = body.children(&mut cursor).collect();

    if let Some(first) = children.first() {
        let is_docstring = if first.kind() == "expression_statement" {
            first
                .child(0)
                .is_some_and(|c| c.kind() == "string" || c.kind() == "concatenated_string")
        } else {
            first.kind() == "string"
        };
        if is_docstring {
            if children.len() == 1 {
                // Only a docstring in body
                return (body.end_byte(), body.end_byte(), String::new());
            }
            let second = children[1];
            let indent_col = second.start_position().column;
            let indent = " ".repeat(indent_col);
            let start = first.end_byte();
            let end = body.end_byte();
            return (start, end, format!("\n{indent}..."));
        }
    }

    let indent_col = body.start_position().column;
    let _ = source;
    let _ = indent_col;
    (body.start_byte(), body.end_byte(), "...".to_string())
}

/// Brace/indentation-aware fallback signature extractor for languages without a Tree-sitter grammar.
fn fallback_skeleton(content: &str) -> String {
    let mut out = Vec::new();
    let mut brace_depth: i32 = 0;
    let mut elided_at_depth: Option<i32> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        let opens = line.chars().filter(|&c| c == '{').count() as i32;
        let closes = line.chars().filter(|&c| c == '}').count() as i32;

        if let Some(target_depth) = elided_at_depth {
            brace_depth += opens - closes;
            if brace_depth < target_depth {
                elided_at_depth = None;
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                out.push(format!("{indent}}}"));
            }
            continue;
        }

        let is_type_or_mod = trimmed.starts_with("struct ")
            || trimmed.starts_with("pub struct ")
            || trimmed.starts_with("enum ")
            || trimmed.starts_with("pub enum ")
            || trimmed.starts_with("interface ")
            || trimmed.starts_with("export interface ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("export class ")
            || trimmed.starts_with("trait ")
            || trimmed.starts_with("pub trait ")
            || trimmed.starts_with("impl ")
            || trimmed.starts_with("mod ")
            || trimmed.starts_with("namespace ");

        let pre_depth = brace_depth;
        brace_depth += opens - closes;

        if opens > closes && pre_depth >= 0 && !is_type_or_mod && trimmed.contains('(') {
            // Likely a function/method opening line
            if let Some(idx) = line.rfind('{') {
                out.push(format!("{} {{ /* ... */ }}", line[..idx].trim_end()));
                elided_at_depth = Some(brace_depth);
                continue;
            }
        }

        out.push(line.to_string());
    }

    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_skeleton_preserves_docs_types_and_signatures() {
        let src = r#"//! Module docs
use std::collections::HashMap;

/// A configuration struct.
pub struct Config {
    pub host: String,
    pub port: u16,
}

/// Computes the answer.
pub fn compute(input: &str, count: usize) -> Result<Vec<String>, String> {
    let mut map = HashMap::new();
    for i in 0..count {
        map.insert(i, input.to_string());
    }
    Ok(map.into_values().collect())
}
"#;
        let skel = extract_skeleton(src, "rust");
        assert!(skel.contains("//! Module docs"), "{skel}");
        assert!(skel.contains("use std::collections::HashMap;"), "{skel}");
        assert!(skel.contains("pub struct Config"), "{skel}");
        assert!(skel.contains("pub host: String,"), "{skel}");
        assert!(skel.contains("/// Computes the answer."), "{skel}");
        assert!(
            skel.contains(
                "pub fn compute(input: &str, count: usize) -> Result<Vec<String>, String> { /* ... */ }"
            ),
            "{skel}"
        );
        assert!(!skel.contains("HashMap::new()"), "{skel}");
    }

    #[test]
    fn typescript_skeleton_preserves_interfaces_and_signatures() {
        let src = r#"import { readFile } from 'fs/promises';

export interface User {
  id: string;
  name: string;
}

export async function loadUser(id: string): Promise<User> {
  const raw = await readFile(`/tmp/${id}.json`, 'utf8');
  const parsed = JSON.parse(raw);
  return { id: parsed.id, name: parsed.name };
}
"#;
        let skel = extract_skeleton(src, "typescript");
        assert!(skel.contains("import { readFile }"), "{skel}");
        assert!(skel.contains("export interface User"), "{skel}");
        assert!(skel.contains("id: string;"), "{skel}");
        assert!(
            skel.contains(
                "export async function loadUser(id: string): Promise<User> { /* ... */ }"
            ),
            "{skel}"
        );
        assert!(!skel.contains("JSON.parse"), "{skel}");
    }

    #[test]
    fn python_skeleton_preserves_docstrings_and_replaces_body() {
        let src = r#"import os
from typing import List

class Processor:
    def run(self, items: List[str]) -> int:
        """Process all items and return count."""
        total = 0
        for item in items:
            if os.path.exists(item):
                total += 1
        return total
"#;
        let skel = extract_skeleton(src, "python");
        assert!(skel.contains("import os"), "{skel}");
        assert!(skel.contains("class Processor:"), "{skel}");
        assert!(
            skel.contains("def run(self, items: List[str]) -> int:"),
            "{skel}"
        );
        assert!(
            skel.contains("\"\"\"Process all items and return count.\"\"\""),
            "{skel}"
        );
        assert!(skel.contains("..."), "{skel}");
        assert!(!skel.contains("os.path.exists"), "{skel}");
    }
}
