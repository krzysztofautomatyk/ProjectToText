//! In-app file preview helpers (path safety, language guess, text load).

use crate::core::text::{decode_text, TextError};
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
    let root_canon = std::fs::canonicalize(root)?;
    resolve_under_canonical_root(&root_canon, relative)
}

/// Same checks as [`resolve_under_root`], for callers that already hold a canonical
/// root. Avoids re-canonicalizing the root for every path in a directory walk.
pub fn resolve_under_canonical_root(root_canon: &Path, relative: &str) -> std::io::Result<PathBuf> {
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

    let mut joined = root_canon.to_path_buf();
    for component in Path::new(&rel).components() {
        joined.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&joined)?;
        if is_link(&metadata) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "symlinks and reparse points are not allowed",
            ));
        }
    }
    let full = std::fs::canonicalize(&joined)?;
    if !full.starts_with(root_canon) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "path is outside the project root",
        ));
    }
    Ok(full)
}

pub(crate) fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

/// Opens `path` as a verified regular file, tying validation to the opened file handle:
/// - Rejects symlinks and Windows reparse points at the path before open (`symlink_metadata`).
/// - Uses `O_NOFOLLOW` on Unix and `FILE_FLAG_OPEN_REPARSE_POINT` on Windows so the kernel
///   never follows a symlink/junction at the final path component.
/// - Inspects `file.metadata()` (`fstat` on the open descriptor) and on Unix verifies that
///   `(dev, ino)` of the open descriptor matches the pre-open `symlink_metadata`, closing
///   the path-to-open TOCTOU swap window for the final component.
pub fn open_verified_regular_file(
    path: &Path,
) -> std::io::Result<(std::fs::File, std::fs::Metadata)> {
    let pre_meta = std::fs::symlink_metadata(path)?;
    if is_link(&pre_meta) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "symlinks and reparse points are not allowed",
        ));
    }
    if pre_meta.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path is a directory",
        ));
    }
    if !pre_meta.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "not a regular file",
        ));
    }

    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);

    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0x0100); // O_NOFOLLOW on BSD / Darwin
    }

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0o100000); // O_NOFOLLOW on Linux aarch64
    }

    #[cfg(all(target_os = "linux", not(target_arch = "aarch64")))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0o400000); // O_NOFOLLOW on Linux x86_64 / others
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }

    let file = opts.open(path)?;
    let post_meta = file.metadata()?;
    if is_link(&post_meta) || !post_meta.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "opened handle is not a regular non-link file",
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if pre_meta.dev() != post_meta.dev() || pre_meta.ino() != post_meta.ino() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "file changed identity (inode/device mismatch) during open",
            ));
        }
    }

    Ok((file, post_meta))
}

/// Reads up to `max_bytes` from a verified regular file handle.
pub fn read_verified_file_string(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    use std::io::Read;
    let (file, meta) = open_verified_regular_file(path)?;
    if meta.len() > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file exceeds maximum size ({max_bytes} bytes)"),
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file grew beyond maximum size ({max_bytes} bytes)"),
        ));
    }
    String::from_utf8(bytes).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
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
    let (file, meta) = open_verified_regular_file(path)?;
    let size = meta.len();
    let language = guess_language(path).to_string();
    let rel_display = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());

    let abs = dunce::simplified(path).display().to_string();

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
    let mut bytes = Vec::with_capacity(to_read);
    {
        use std::io::Read;
        file.take(to_read as u64).read_to_end(&mut bytes)?;
    }

    let truncated = size > max_bytes;
    let decoded = decode_text(&bytes, truncated);

    if decoded == Err(TextError::Binary) {
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

    let mut content = decoded.map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid text encoding: use UTF-8 or UTF-16 with BOM",
        )
    })?;
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

    #[cfg(unix)]
    #[test]
    fn open_verified_regular_file_rejects_final_symlink_via_nofollow_and_load_preview_fails_closed()
    {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("secret.txt");
        fs::write(&target, "OUTSIDE_SECRET_PAYLOAD").unwrap();
        let link = dir.path().join("final_link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(open_verified_regular_file(&link).is_err());
        assert!(load_preview(&link, 1024).is_err());
        assert!(read_verified_file_string(&link, 1024).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn sandbox_rejects_symlinked_directory_components_and_escapes_before_open() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "OUTSIDE_SECRET_PAYLOAD").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linkdir")).unwrap();
        fs::write(root.path().join("inside.txt"), "INSIDE").unwrap();
        std::os::unix::fs::symlink(
            root.path().join("inside.txt"),
            root.path().join("alias.txt"),
        )
        .unwrap();

        // Intermediate symlink component pointing outside the root.
        let err = resolve_under_root(root.path(), "linkdir/secret.txt").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // Symlink to a file inside the root is still a link, so it is rejected too.
        let err = resolve_under_root(root.path(), "alias.txt").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // Traversal and absolute paths never reach the filesystem.
        for bad in ["../outside/secret.txt", "a/../../x", "/etc/passwd"] {
            assert!(
                resolve_under_root(root.path(), bad).is_err(),
                "{bad} was accepted"
            );
        }
        // The verified open itself refuses a symlink at the final component.
        assert!(open_verified_regular_file(&root.path().join("alias.txt")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_swap_between_regular_file_and_symlink_never_yields_outside_content() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "OUTSIDE_SECRET_PAYLOAD").unwrap();
        let path = root.path().join("target.txt");
        fs::write(&path, "INSIDE_PAYLOAD").unwrap();
        let flips = 2_000usize;

        // The swapper replaces `target.txt` with a symlink to the outside secret and back again.
        // Each replacement is one atomic rename, so the path always exists.
        let swap_path = path.clone();
        let swap_root = root.path().to_path_buf();
        let swap_secret = secret.clone();
        let swapper = std::thread::spawn(move || {
            for _ in 0..flips {
                let link_tmp = swap_root.join("swap.lnk");
                let _ = fs::remove_file(&link_tmp);
                std::os::unix::fs::symlink(&swap_secret, &link_tmp).unwrap();
                fs::rename(&link_tmp, &swap_path).unwrap();

                let reg_tmp = swap_root.join("swap.reg");
                fs::write(&reg_tmp, "INSIDE_PAYLOAD").unwrap();
                fs::rename(&reg_tmp, &swap_path).unwrap();
            }
        });

        let (mut opened, mut refused) = (0usize, 0usize);
        for _ in 0..flips * 2 {
            match read_verified_file_string(&path, 4096) {
                Ok(text) => {
                    assert!(
                        !text.contains("OUTSIDE"),
                        "verified open returned outside content during a swap"
                    );
                    assert_eq!(text, "INSIDE_PAYLOAD");
                    opened += 1;
                }
                Err(_) => refused += 1,
            }
        }
        swapper.join().expect("swapper thread panicked");
        assert_eq!(opened + refused, flips * 2);
        eprintln!("swap race: {opened} regular opens, {refused} refused");
    }
}
