//! Native Rust AST Skeletonizer ("Skeleton Mode").
//!
//! Uses `tree-sitter` to parse source files and replace function/method
//! implementation bodies with `{ /* ... */ }` (or `...` in Python), preserving:
//! - Module/package declarations, `use` / `import` / `export` statements
//! - Type, `struct`, `enum`, `interface`, `trait`, `class` definitions and fields
//! - Function/method signatures, visibility modifiers, attributes/decorators, and doc comments
//!
//! For unsupported languages, provides an indentation/brace-aware fallback signature extractor.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use tree_sitter::{Language, Node, Parser, Tree};

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

/// Maps a language name to its grammar key, grammar, and whether it uses Python-style bodies.
fn ts_language(lang: &str) -> Option<(&'static str, Language, bool)> {
    match lang.trim().to_ascii_lowercase().as_str() {
        "rust" | "rs" => Some(("rust", tree_sitter_rust::LANGUAGE.into(), false)),
        "typescript" | "ts" => Some((
            "typescript",
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            false,
        )),
        "tsx" => Some(("tsx", tree_sitter_typescript::LANGUAGE_TSX.into(), false)),
        "javascript" | "js" | "jsx" => {
            Some(("javascript", tree_sitter_javascript::LANGUAGE.into(), false))
        }
        "python" | "py" => Some(("python", tree_sitter_python::LANGUAGE.into(), true)),
        "go" => Some(("go", tree_sitter_go::LANGUAGE.into(), false)),
        "csharp" | "c_sharp" | "cs" => {
            Some(("csharp", tree_sitter_c_sharp::LANGUAGE.into(), false))
        }
        "java" => Some(("java", tree_sitter_java::LANGUAGE.into(), false)),
        "c" => Some(("c", tree_sitter_c::LANGUAGE.into(), false)),
        "cpp" | "c++" | "cc" | "hpp" => Some(("cpp", tree_sitter_cpp::LANGUAGE.into(), false)),
        _ => None,
    }
}

thread_local! {
    /// One parser per grammar and worker thread: `Parser::new` is far more costly than reuse.
    static PARSERS: RefCell<HashMap<&'static str, Parser>> = RefCell::new(HashMap::new());
}

/// Parses `content` with this thread's cached parser for `key`. Returns `None` when the grammar
/// cannot be loaded or parsing fails.
fn parse_with_cached_parser(key: &'static str, language: &Language, content: &str) -> Option<Tree> {
    PARSERS.with(|cell| {
        let mut parsers = cell.borrow_mut();
        let parser = parsers.entry(key).or_insert_with(|| {
            let mut parser = Parser::new();
            let _ = parser.set_language(language);
            parser
        });
        parser.parse(content, None)
    })
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

    let Some((key, ts_lang, is_python)) = ts_language(language) else {
        return fallback_skeleton(content);
    };
    let Some(tree) = parse_with_cached_parser(key, &ts_lang, content) else {
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

/// Named definitions that [`find_symbols`] can return. Each kind is named by [`extract_symbol_name`];
/// kinds that it cannot name are skipped.
fn is_symbol_kind(kind: &str) -> bool {
    matches!(
        kind,
        // Rust
        "function_item" | "struct_item" | "enum_item" | "trait_item" | "type_item"
        | "impl_item" | "macro_definition" | "const_item" | "static_item"
        | "use_declaration" | "mod_item"
        // TypeScript / JavaScript
        | "function_declaration"
        | "variable_declarator"
        | "generator_function_declaration"
        | "class_declaration"
        | "interface_declaration"
        | "type_alias_declaration"
        | "enum_declaration"
        | "method_definition"
        | "export_specifier"
        | "namespace_export"
        | "import_specifier"
        // Python
        | "function_definition"
        | "class_definition"
        // Go
        | "method_declaration"
        | "type_spec"
        | "const_spec"
        | "var_spec"
        // Java / C#
        | "constructor_declaration"
        | "record_declaration"
        | "struct_declaration"
        // C / C++
        | "struct_specifier"
        | "enum_specifier"
        | "class_specifier"
    )
}

/// A named definition returned by [`find_symbols`], with its exact source span.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub name: String,
    pub kind: String,
    /// 1-based, inclusive.
    pub start_line: usize,
    /// 1-based, inclusive.
    pub end_line: usize,
    pub source: String,
}

/// Finds named definitions (functions, methods, types, classes, interfaces, traits) whose name
/// contains `query`, compared case-insensitively. Returns each definition's exact source span.
/// Returns nothing for an empty query or an unsupported language.
pub fn find_symbols(content: &str, language: &str, query: &str) -> Vec<SymbolMatch> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let Some((key, ts_lang, _)) = ts_language(language) else {
        return Vec::new();
    };
    let Some(tree) = parse_with_cached_parser(key, &ts_lang, content) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    collect_symbols(tree.root_node(), content.as_bytes(), &needle, &mut out);
    out
}

/// Name of a symbol node. Most grammars expose a `name` field. C/C++ functions keep their name in the
/// `declarator` chain, Rust `impl` blocks are named by their `type`, and a TS/JS variable is a symbol
/// only when its value is a function.
fn extract_symbol_name<'a>(node: Node<'_>, source: &'a [u8]) -> Option<&'a str> {
    let text = |n: Node<'_>| n.utf8_text(source).ok();
    match node.kind() {
        "variable_declarator" => {
            let value = node.child_by_field_name("value")?;
            if !matches!(value.kind(), "arrow_function" | "function_expression") {
                return None;
            }
            text(node.child_by_field_name("name")?)
        }
        "impl_item" => text(node.child_by_field_name("type")?),
        // A `use` declaration can bind several names (`pub use a::{B, C as D};`), so `collect_symbols`
        // names it with `collect_use_export_names` instead of returning one name here.
        "use_declaration" => None,
        // `pub mod name;` is a declaration. An inline module is a whole body, not a name to look up.
        "mod_item" => {
            if node.child_by_field_name("body").is_some() {
                return None;
            }
            text(node.child_by_field_name("name")?)
        }
        // `export { orig as alias }` is named by its alias; `export { orig }` by the original name.
        "export_specifier" => text(
            node.child_by_field_name("alias")
                .or_else(|| node.child_by_field_name("name"))?,
        ),
        // `import { orig as alias } from '...'` binds `alias`. An import without an alias binds its own
        // name and is plumbing, so it is not a symbol.
        "import_specifier" => text(node.child_by_field_name("alias")?),
        // `export * as ns from '...'` exports `ns`.
        "namespace_export" => {
            let mut cursor = node.walk();
            let name = node.named_children(&mut cursor).last()?;
            text(name)
        }
        kind => {
            if let Some(name) = node.child_by_field_name("name") {
                return text(name);
            }
            if kind == "function_definition" {
                let mut cur = node.child_by_field_name("declarator")?;
                loop {
                    match cur.kind() {
                        "identifier"
                        | "field_identifier"
                        | "qualified_identifier"
                        | "destructor_name" => {
                            return text(cur);
                        }
                        _ => cur = cur.child_by_field_name("declarator")?,
                    }
                }
            }
            None
        }
    }
}

/// Recursively collects all exported symbol names from a Rust `pub use` argument node.
/// Handles:
/// - `pub use a::b::Name;` -> `["Name"]`
/// - `pub use a::b::Name as Alias;` -> `["Alias"]`
/// - `pub use a::b::{Foo, Bar as Baz, sub::{Qux}};` -> `["Foo", "Baz", "Qux"]`
///
/// Glob imports (`use a::*`) bind no named symbol and are skipped.
fn collect_use_export_names<'a>(node: Node<'_>, source: &'a [u8], out: &mut Vec<&'a str>) {
    let text = |n: Node<'_>| n.utf8_text(source).ok();
    match node.kind() {
        "identifier" => {
            if let Some(s) = text(node) {
                if !matches!(s, "self" | "super" | "crate") {
                    out.push(s);
                }
            }
        }
        "scoped_identifier" => {
            if let Some(name) = node.child_by_field_name("name").and_then(text) {
                if name != "self" {
                    out.push(name);
                }
            }
        }
        "use_as_clause" => {
            if let Some(alias) = node.child_by_field_name("alias").and_then(text) {
                out.push(alias);
            }
        }
        "scoped_use_list" => {
            if let Some(list) = node.child_by_field_name("list") {
                collect_use_export_names(list, source, out);
            }
        }
        "use_list" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                collect_use_export_names(child, source, out);
            }
        }
        _ => {}
    }
}

/// The node whose source is reported for a symbol. A variable-bound function is reported with its whole
/// declaration (and the `export` keyword, when present), so the snippet is a complete statement.
fn symbol_span_node(node: Node<'_>) -> Node<'_> {
    // A specifier is reported with its whole statement, not just the specifier: `export { ... } from`,
    // `export * as ns from`, or `import { a as b } from`.
    let statement = match node.kind() {
        "export_specifier" | "namespace_export" => Some("export_statement"),
        "import_specifier" => Some("import_statement"),
        _ => None,
    };
    if let Some(statement) = statement {
        return std::iter::successors(node.parent(), |n| n.parent())
            .find(|n| n.kind() == statement)
            .unwrap_or(node);
    }
    if matches!(node.kind(), "const_spec" | "var_spec") {
        // A single-spec `const X = 1` is reported with its keyword; a grouped spec stays on its own line.
        return match node.parent() {
            Some(decl)
                if matches!(decl.kind(), "const_declaration" | "var_declaration")
                    && decl.named_child_count() == 1 =>
            {
                decl
            }
            _ => node,
        };
    }
    if node.kind() != "variable_declarator" {
        return node;
    }
    let mut span = node;
    while let Some(parent) = span.parent() {
        if matches!(
            parent.kind(),
            "lexical_declaration" | "variable_declaration" | "export_statement"
        ) {
            span = parent;
        } else {
            break;
        }
    }
    span
}

fn collect_symbols(node: Node<'_>, source: &[u8], needle: &str, out: &mut Vec<SymbolMatch>) {
    if node.kind() == "use_declaration" {
        push_use_declaration_symbols(node, source, needle, out);
    } else if is_symbol_kind(node.kind()) {
        if let Some(name) = extract_symbol_name(node, source) {
            if name.to_ascii_lowercase().contains(needle) {
                let span = symbol_span_node(node);
                if let Ok(text) = span.utf8_text(source) {
                    out.push(SymbolMatch {
                        name: name.to_string(),
                        kind: span.kind().to_string(),
                        start_line: span.start_position().row + 1,
                        end_line: span.end_position().row + 1,
                        source: text.to_string(),
                    });
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_symbols(child, source, needle, out);
    }
}

/// A `pub use` declaration can re-export several names (`pub use a::{B, C as D};`). Each matching name is
/// reported separately, all with the declaration's span. Private `use` declarations are plumbing.
fn push_use_declaration_symbols(
    node: Node<'_>,
    source: &[u8],
    needle: &str,
    out: &mut Vec<SymbolMatch>,
) {
    let mut cursor = node.walk();
    let is_pub = node
        .children(&mut cursor)
        .any(|child| child.kind() == "visibility_modifier");
    if !is_pub {
        return;
    }
    let Some(argument) = node.child_by_field_name("argument") else {
        return;
    };
    let mut names = Vec::new();
    collect_use_export_names(argument, source, &mut names);
    let Ok(text) = node.utf8_text(source) else {
        return;
    };
    for name in names {
        if name.to_ascii_lowercase().contains(needle) {
            out.push(SymbolMatch {
                name: name.to_string(),
                kind: "use_declaration".to_string(),
                start_line: node.start_position().row + 1,
                end_line: node.end_position().row + 1,
                source: text.to_string(),
            });
        }
    }
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
    } else if !is_python && (kind == "public_field_definition" || kind == "field_definition") {
        // Class fields holding an arrow function or function expression: `handle = () => { ... }`
        if let Some(val) = node.child_by_field_name("value") {
            if val.kind() == "arrow_function" || val.kind() == "function_expression" {
                if let Some(body) = val.child_by_field_name("body") {
                    if body.kind() == "statement_block" {
                        let start = body.start_byte();
                        let end = body.end_byte();
                        if end.saturating_sub(start) > 18 || source[start..end].contains(&b'\n') {
                            out.push((start, end, "{ /* ... */ }".to_string()));
                        }
                    }
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
    fn find_symbols_resolves_rust_reexports_and_module_declarations() {
        let src = "pub use crate::core::walker::walk as scan_repo;\npub use crate::core::deps::DependencyGraph;\npub mod walker;\nmod inline { pub fn hidden() {} }\nuse std::fmt;\n";
        let alias = find_symbols(src, "rust", "scan_repo");
        assert_eq!(alias.len(), 1, "{alias:?}");
        assert_eq!(alias[0].kind, "use_declaration");
        assert_eq!(
            alias[0].source,
            "pub use crate::core::walker::walk as scan_repo;"
        );
        assert_eq!(find_symbols(src, "rust", "DependencyGraph").len(), 1);
        let module = find_symbols(src, "rust", "walker");
        assert_eq!(module.len(), 1, "{module:?}");
        assert_eq!(module[0].source, "pub mod walker;");
        // Private `use` and inline modules are not reported as symbols.
        assert!(find_symbols(src, "rust", "fmt").is_empty());
        assert!(find_symbols(src, "rust", "inline").is_empty());
    }

    #[test]
    fn find_symbols_resolves_grouped_rust_reexports() {
        let src = "pub use core::deps::{DependencyGraph, RelatedFiles as Rel};\n";
        let dep = find_symbols(src, "rust", "DependencyGraph");
        assert_eq!(dep.len(), 1, "{dep:?}");
        assert_eq!(dep[0].name, "DependencyGraph");
        assert_eq!(dep[0].kind, "use_declaration");
        assert_eq!(
            dep[0].source,
            "pub use core::deps::{DependencyGraph, RelatedFiles as Rel};"
        );
        let alias = find_symbols(src, "rust", "rel");
        assert_eq!(alias.len(), 1, "{alias:?}");
        assert_eq!(alias[0].name, "Rel");
        // Nested groups, `self`, and globs: only the bound names are symbols.
        let nested = "pub use a::{b::{Inner}, self, C, *};\n";
        assert_eq!(find_symbols(nested, "rust", "inner")[0].name, "Inner");
        assert_eq!(find_symbols(nested, "rust", "c")[0].name, "C");
        assert!(find_symbols(nested, "rust", "self").is_empty());
        assert!(find_symbols(nested, "rust", "super").is_empty());
        // A private grouped `use` is plumbing, not a symbol.
        assert!(find_symbols("use core::deps::{DependencyGraph};\n", "rust", "deps").is_empty());
    }

    #[test]
    fn find_symbols_finds_grouped_reexports_in_this_crate_root() {
        let lib = include_str!("../lib.rs");
        let hits = find_symbols(lib, "rust", "write_output_with_stats");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].kind, "use_declaration");
        assert!(
            hits[0].source.starts_with("pub use core::output::{"),
            "{hits:?}"
        );
    }

    #[test]
    fn find_symbols_resolves_typescript_import_and_namespace_aliases() {
        let src = "import { readFile as loadRaw } from 'fs';\nexport * as ns from './mod';\nimport { plain } from './p';\n";
        let loaded = find_symbols(src, "typescript", "loadRaw");
        assert_eq!(loaded.len(), 1, "{loaded:?}");
        assert_eq!(loaded[0].kind, "import_statement");
        assert_eq!(
            loaded[0].source,
            "import { readFile as loadRaw } from 'fs';"
        );
        let ns = find_symbols(src, "typescript", "ns");
        assert_eq!(ns.len(), 1, "{ns:?}");
        assert_eq!(ns[0].kind, "export_statement");
        assert_eq!(ns[0].source, "export * as ns from './mod';");
        // An import without an alias binds its own name, so it is not a new symbol.
        assert!(find_symbols(src, "typescript", "plain").is_empty());
    }

    #[test]
    fn find_symbols_resolves_typescript_export_aliases() {
        let src = "export { redactSecrets as maskCredentials } from './secrets';\nconst x = 1;\n";
        let found = find_symbols(src, "typescript", "maskCredentials");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].kind, "export_statement");
        assert_eq!(
            found[0].source,
            "export { redactSecrets as maskCredentials } from './secrets';"
        );
        // A symbol is named by its exported name: the original name is not an export of this file.
        assert!(find_symbols(src, "typescript", "redactSecrets").is_empty());
    }

    #[test]
    fn find_symbols_names_go_const_and_var_specs() {
        let src = "package main\n\nconst MaxRetries = 5\n\nvar (\n\tDefaultName = \"ptt\"\n\tlimit int\n)\n";
        let constant = find_symbols(src, "go", "maxretries");
        assert_eq!(constant.len(), 1, "{constant:?}");
        assert_eq!(constant[0].source, "const MaxRetries = 5");
        let limit = find_symbols(src, "go", "limit");
        assert_eq!(limit.len(), 1, "{limit:?}");
        assert_eq!(limit[0].kind, "var_spec");
        assert_eq!(limit[0].source, "limit int");
        assert_eq!(
            find_symbols(src, "go", "defaultname")[0].source,
            "DefaultName = \"ptt\""
        );
    }

    #[test]
    fn find_symbols_returns_exact_spans_and_is_case_insensitive() {
        let src = "pub struct Config {\n    pub host: String,\n}\n\npub fn compute(x: usize) -> usize {\n    let y = x * 2;\n    y + 1\n}\n";
        let hits = find_symbols(src, "rust", "COMPUTE");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].name, "compute");
        assert_eq!(hits[0].kind, "function_item");
        assert_eq!((hits[0].start_line, hits[0].end_line), (5, 8));
        assert!(hits[0].source.contains("let y = x * 2;"), "{:?}", hits[0]);

        assert_eq!(find_symbols(src, "rust", "config").len(), 1);
        assert!(find_symbols(src, "rust", "  ").is_empty());
        assert!(find_symbols(src, "other", "compute").is_empty());
    }

    #[test]
    fn find_symbols_covers_c_typescript_arrow_and_rust_items() {
        let c = "int compute_sum(int a, int b) { return a + b; }\n";
        let hits = find_symbols(c, "c", "compute_sum");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].name, "compute_sum");
        assert!(hits[0].source.contains("return a + b;"), "{:?}", hits[0]);

        let ts = "export const useAuth = () => {\n  return true;\n};\n";
        let hits = find_symbols(ts, "typescript", "useauth");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].name, "useAuth");
        assert_eq!((hits[0].start_line, hits[0].end_line), (1, 3));
        assert!(
            hits[0].source.starts_with("export const useAuth"),
            "{:?}",
            hits[0]
        );
        assert!(find_symbols("const plain = 42;\n", "typescript", "plain").is_empty());

        let rs = "macro_rules! make_it { () => {} }\npub const LIMIT: usize = 4;\npub static NAME: &str = \"x\";\npub struct Widget;\nimpl Widget { pub fn new() -> Self { Widget } }\n";
        assert_eq!(find_symbols(rs, "rust", "make_it").len(), 1);
        assert_eq!(find_symbols(rs, "rust", "limit").len(), 1);
        assert_eq!(find_symbols(rs, "rust", "name").len(), 1);
        let widget: Vec<String> = find_symbols(rs, "rust", "widget")
            .into_iter()
            .map(|s| s.kind)
            .collect();
        assert_eq!(widget, vec!["struct_item", "impl_item"]);
    }

    #[test]
    fn typescript_class_arrow_field_body_is_elided() {
        let src = "export class Panel {\n  handleClick = (event: MouseEvent): void => {\n    const target = event.target;\n    console.log(target);\n  };\n}\n";
        let skel = extract_skeleton(src, "typescript");
        assert!(
            skel.contains("handleClick = (event: MouseEvent): void =>"),
            "{skel}"
        );
        assert!(skel.contains("{ /* ... */ }"), "{skel}");
        assert!(!skel.contains("console.log"), "{skel}");
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
