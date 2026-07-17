//! In-app file preview helpers (path safety, language guess, text load).

use content_inspector;
use encoding_rs;
use std::path::{Component, Path, PathBuf};

/// Default max bytes loaded into the in-app viewer.
pub const DEFAULT_PREVIEW_MAX: u64 = 512 * 1024; // 512 KiB

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePreview {
    pub path: String,
    pub language: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    pub absolute_path: String,
}

/// Reject `..` and absolute segments; resolve under `root`.
pub fn resolve_under_root(root: &Path, relative: &str) -> std::io::Result<PathBuf> {
    let rel = relative.replace('\\', "/");
    if rel.is_empty() || rel == "." {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "empty relative path",
        ));
    }
    if Path::new(&rel).is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "absolute paths are not allowed",
        ));
    }
    for c in Path::new(&rel).components() {
        match c {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "path escapes project root",
                ));
            }
        }
    }

    let root_canon = std::fs::canonicalize(root)?;
    let joined = root_canon.join(&rel);
    let full = std::fs::canonicalize(&joined).unwrap_or(joined);
    if !full.starts_with(&root_canon) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "path is outside the project root",
        ));
    }
    Ok(full)
}

/// Map file extension / name → highlight.js-style language id.
pub fn guess_language(path: &Path) -> &'static str {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Multi-dot / special names first
    if name.ends_with(".xaml.cs") || name.ends_with(".razor.cs") {
        return "csharp";
    }
    if name == "dockerfile" || name.starts_with("dockerfile.") {
        return "dockerfile";
    }
    if name == "makefile" || name == "gnumakefile" {
        return "makefile";
    }
    if name == "cargo.toml" || name == "pyproject.toml" {
        return "toml";
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascript",
        "json" | "jsonc" => "json",
        "md" | "mdx" | "markdown" => "markdown",
        "py" | "pyw" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "cs" => "csharp",
        "fs" | "fsi" | "fsx" => "fsharp",
        "vb" => "vbnet",
        "xaml" | "axaml" => "xml",
        "xml" | "xsl" | "xslt" | "csproj" | "fsproj" | "vbproj" | "props" | "targets" | "resx"
        | "config" | "nuspec" | "plist" => "xml",
        "html" | "htm" | "cshtml" | "razor" | "vue" | "svelte" => "xml",
        "css" | "scss" | "less" => "css",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        "ps1" | "psm1" => "powershell",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "ini" | "cfg" | "conf" | "env" => "ini",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        "rb" => "ruby",
        "php" => "php",
        "r" => "r",
        "lua" => "lua",
        "dart" => "dart",
        "gradle" => "gradle",
        "sln" => "plaintext",
        "txt" | "log" | "gitignore" | "dockerignore" | "editorconfig" => "plaintext",
        _ => "plaintext",
    }
}

pub fn load_preview(path: &Path, max_bytes: u64) -> std::io::Result<FilePreview> {
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path is a directory",
        ));
    }
    let size = meta.len();
    let language = guess_language(path).to_string();
    let rel_display = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());

    let abs = path.display().to_string();

    if size == 0 {
        return Ok(FilePreview {
            path: rel_display,
            language,
            content: String::new(),
            size: 0,
            truncated: false,
            binary: false,
            absolute_path: abs,
        });
    }

    let to_read = size.min(max_bytes) as usize;
    let mut bytes = vec![0u8; to_read];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        f.read_exact(&mut bytes)?;
    }

    let sample_len = bytes.len().min(8192);
    let binary = bytes.contains(&0) || content_inspector::inspect(&bytes[..sample_len]).is_binary();

    if binary {
        return Ok(FilePreview {
            path: rel_display,
            language: "plaintext".into(),
            content: format!("[Binary file — {size} bytes. Open with an external app to view.]"),
            size,
            truncated: false,
            binary: true,
            absolute_path: abs,
        });
    }

    let (decoded, _, _) = encoding_rs::UTF_8.decode(&bytes);
    let mut content = decoded.into_owned();
    let truncated = size > max_bytes;
    if truncated {
        content.push_str(&format!(
            "\n\n// … truncated for preview ({size} bytes total, showing first {max_bytes}) …"
        ));
    }

    Ok(FilePreview {
        path: rel_display,
        language,
        content,
        size,
        truncated,
        binary: false,
        absolute_path: abs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolve_blocks_parent_escape() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_under_root(dir.path(), "../secret").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn resolve_allows_nested() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("b.cs"), "class A {}").unwrap();
        let p = resolve_under_root(dir.path(), "a/b.cs").unwrap();
        assert!(p.ends_with("b.cs"));
    }

    #[test]
    fn guess_xaml_and_cs() {
        assert_eq!(guess_language(Path::new("MainWindow.xaml")), "xml");
        assert_eq!(guess_language(Path::new("MainWindow.xaml.cs")), "csharp");
        assert_eq!(guess_language(Path::new("App.csproj")), "xml");
        assert_eq!(guess_language(Path::new("Program.cs")), "csharp");
    }

    #[test]
    fn load_text_preview() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("hi.xaml");
        fs::write(&f, "<Grid />\n").unwrap();
        let prev = load_preview(&f, 1024).unwrap();
        assert!(!prev.binary);
        assert!(prev.content.contains("Grid"));
        assert_eq!(prev.language, "xml");
    }

    #[test]
    fn load_respects_max() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("big.txt");
        fs::write(&f, "abcdefghij").unwrap();
        let prev = load_preview(&f, 4).unwrap();
        assert!(prev.truncated);
        assert!(prev.content.starts_with("abcd"));
    }
}
