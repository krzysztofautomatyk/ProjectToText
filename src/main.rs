//! ptt — ProjectToText
//! Tauri v2 desktop app: open folder → respect .gitignore exactly like Git → pack into LLM-ready text.
//! Headless: `ptt pack [DIR] [OPTIONS]` (see `cli` module).

// On Windows, build as a GUI app in release mode so no empty console window
// appears next to the desktop UI. In dev/debug builds we keep the console
// subsystem so `cargo run` still shows CLI output (`ptt pack ...`).
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

mod cli;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

use ptt::core::output::OutputFormat;
use ptt::core::output::{WriteOptions, DEFAULT_MAX_FILE_SIZE};
use ptt::core::preview::{load_preview, resolve_under_root, DEFAULT_PREVIEW_MAX};
use ptt::core::walker::normalize_rel_path;
use ptt::core::workspace::WorkspaceIndex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Default)]
struct DesktopState {
    workspace: Arc<WorkspaceIndex>,
    startup_folder: Option<String>,
    /// Bumped by every `generate_output` call so an older pack stops at its next file.
    generation: Arc<AtomicU64>,
}

#[derive(Serialize)]
struct ScanResult {
    root: String,
    revision: u64,
    nodes: Vec<FileNode>,
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub children: Option<Vec<FileNode>>,
    pub selected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PackOptions {
    pub format: String,
    pub include_summary: bool,
    pub max_file_size: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewDto {
    pub path: String,
    pub relative_path: String,
    pub language: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    pub absolute_path: String,
}

#[tauri::command]
async fn select_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |maybe_path| {
        let result = maybe_path.map(|p| p.to_string());
        let _ = tx.send(result);
    });
    rx.await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_folder(
    path: String,
    state: tauri::State<'_, DesktopState>,
) -> Result<ScanResult, String> {
    let index = state.workspace.clone();
    blocking(move || {
        let snapshot = index.scan(Path::new(&path))?;
        let nodes: Vec<FileNode> = snapshot
            .entries
            .iter()
            .map(|e| {
                let path_str = normalize_rel_path(&e.path);
                let name = e
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.clone());
                FileNode {
                    path: path_str,
                    name,
                    is_dir: e.is_dir,
                    size: e.size,
                    children: None,
                    selected: false,
                }
            })
            .collect();

        Ok(ScanResult {
            root: snapshot.root.to_string_lossy().into_owned(),
            revision: snapshot.revision,
            nodes,
        })
    })
    .await
}

#[tauri::command]
fn startup_folder(state: tauri::State<'_, DesktopState>) -> Option<String> {
    state.startup_folder.clone()
}

#[tauri::command]
async fn generate_output(
    path: String,
    selected_paths: Vec<String>,
    options: PackOptions,
    revision: u64,
    state: tauri::State<'_, DesktopState>,
) -> Result<String, String> {
    let generation = state.generation.clone();
    let request = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let index = state.workspace.clone();
    blocking(move || {
        let snapshot = index.get(Path::new(&path), revision)?;
        let root = &snapshot.root;
        let filtered = snapshot.selected(&selected_paths);

        let format = match options.format.as_str() {
            "markdown" => OutputFormat::Markdown,
            "json" => OutputFormat::Json,
            "plain" => OutputFormat::Plain,
            _ => OutputFormat::Xml,
        };

        let write_opts = WriteOptions {
            format,
            include_file_summary: options.include_summary,
            max_file_size: options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE),
        };

        let mut buf = Vec::new();
        let is_superseded = || generation.load(Ordering::SeqCst) != request;
        ptt::write_output_cancellable(&mut buf, &filtered, root, &write_opts, &is_superseded)
            .map_err(|e| e.to_string())?;

        String::from_utf8(buf).map_err(|e| format!("Output is not valid UTF-8: {e}"))
    })
    .await
}

#[tauri::command]
async fn read_file_preview(
    root: String,
    relative_path: String,
    max_bytes: Option<u64>,
) -> Result<FilePreviewDto, String> {
    blocking(move || {
        let root_pb = PathBuf::from(&root);
        let full = resolve_under_root(&root_pb, &relative_path).map_err(|e| e.to_string())?;
        let max = max_bytes.unwrap_or(DEFAULT_PREVIEW_MAX);
        let prev = load_preview(&full, max).map_err(|e| e.to_string())?;
        Ok(FilePreviewDto {
            path: prev.path,
            relative_path: relative_path.replace('\\', "/"),
            language: prev.language,
            content: prev.content,
            size: prev.size,
            truncated: prev.truncated,
            binary: prev.binary,
            absolute_path: prev.absolute_path,
        })
    })
    .await
}

/// Extensions that run code when opened. The default-app action refuses them, so one
/// click on a script from a cloned repo cannot execute it.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "bat", "cmd", "com", "scr", "msi", "msix", "ps1", "psm1", "vbs", "vbe", "js", "jse",
    "wsf", "wsh", "hta", "lnk", "reg", "jar", "sh", "command", "app", "pkg", "dmg", "appimage",
];

fn is_executable_like(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXECUTABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Editors the UI may launch by name. Anything else must go through the file picker.
const KNOWN_EDITORS: &[&str] = &["code", "code-insiders", "cursor", "notepad++"];

fn validate_editor_command(app: &str) -> Result<&str, String> {
    let app = app.trim();
    if KNOWN_EDITORS.contains(&app) {
        Ok(app)
    } else {
        Err(format!(
            "\"{app}\" is not a known editor. Use \"Choose program\u{2026}\" to pick one."
        ))
    }
}

/// Open a project file with the OS default application.
#[tauri::command]
async fn open_in_default_app(root: String, relative_path: String) -> Result<(), String> {
    blocking(move || {
    let full =
        resolve_under_root(&PathBuf::from(&root), &relative_path).map_err(|e| e.to_string())?;
    if is_executable_like(&full) {
        return Err(
            "Executables and scripts are not opened with the default app. Use \"Open with\u{2026}\" to choose a program."
                .into(),
        );
    }
    open::that(dunce::simplified(&full)).map_err(|e| format!("Failed to open file: {e}"))
    }).await
}

/// Open a project file with one of the known editors (see `KNOWN_EDITORS`).
#[tauri::command]
async fn open_with_app(root: String, relative_path: String, app: String) -> Result<(), String> {
    blocking(move || {
        let full =
            resolve_under_root(&PathBuf::from(&root), &relative_path).map_err(|e| e.to_string())?;
        let app = validate_editor_command(&app)?;
        open::with(dunce::simplified(&full), app)
            .map_err(|e| format!("Failed to open with {app}: {e}"))
    })
    .await
}

/// Only https links may be opened from the UI (e.g. the About dialog's repository link).
fn validate_https_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .ok_or("Only https:// links can be opened")?;
    if rest.is_empty() || rest.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Invalid link".into());
    }
    Ok(trimmed)
}

/// Open an https link in the system browser.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    blocking(move || {
        let link = validate_https_url(&url)?;
        open::that(link).map_err(|e| format!("Failed to open link: {e}"))
    })
    .await
}

/// Pick an application via file dialog, then open the project file with it.
/// Returns `true` if opened, `false` if the dialog was cancelled.
#[tauri::command]
async fn pick_app_and_open(
    app_handle: tauri::AppHandle,
    root: String,
    relative_path: String,
) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    #[cfg(target_os = "windows")]
    let filters = vec![("Applications", vec!["exe", "cmd", "bat"])];
    #[cfg(target_os = "macos")]
    let filters = vec![("Applications", vec!["app"])];
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let filters: Vec<(&str, Vec<&str>)> = vec![];

    let mut builder = app_handle.dialog().file();
    for (name, exts) in filters {
        builder = builder.add_filter(name, &exts);
    }
    builder.pick_file(move |maybe| {
        let result = maybe.map(|p| p.to_string());
        let _ = tx.send(result);
    });

    match rx.await {
        Ok(Some(app_path)) => {
            blocking(move || {
                let full = resolve_under_root(Path::new(&root), &relative_path)
                    .map_err(|error| error.to_string())?;
                open::with(dunce::simplified(&full), &app_path)
                    .map_err(|e| format!("Failed to open with selected app: {e}"))?;
                Ok(true)
            })
            .await
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn copy_to_clipboard(text: String) -> Result<(), String> {
    blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut c| c.set_text(text))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn save_to_file(
    app: tauri::AppHandle,
    text: String,
    default_name: String,
) -> Result<bool, String> {
    let name = if default_name.trim().is_empty() {
        "project.txt".to_string()
    } else {
        default_name
    };

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    app.dialog()
        .file()
        .set_file_name(&name)
        .save_file(move |maybe_path| {
            let result = maybe_path.map(|p| p.to_string());
            let _ = tx.send(result);
        });
    match rx.await {
        Ok(Some(path)) => {
            blocking(move || {
                std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
                Ok(true)
            })
            .await
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// On Windows GUI-subsystem builds the process has no console, so a
/// terminal-launched CLI run (`ptt pack`) would print nothing. Attach to the
/// parent console (only present when launched from a terminal); a GUI launch
/// from Explorer/Start Menu has no such parent and opens nothing.
#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn attach_parent_console() {
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF; // (DWORD)-1
    extern "system" {
        fn AttachConsole(process: u32) -> i32;
    }
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(all(target_os = "windows", not(debug_assertions))))]
fn attach_parent_console() {}

fn main() {
    attach_parent_console();

    // Headless packing without launching the GUI webview.
    let startup = match cli::maybe_run() {
        cli::Launch::Headless => return,
        cli::Launch::Desktop(folder) => folder,
    };

    tauri::Builder::default()
        .manage(DesktopState {
            startup_folder: startup,
            ..Default::default()
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            select_folder,
            startup_folder,
            scan_folder,
            generate_output,
            read_file_preview,
            open_in_default_app,
            open_with_app,
            open_url,
            pick_app_and_open,
            copy_to_clipboard,
            save_to_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{is_executable_like, validate_editor_command, validate_https_url};
    use std::path::Path;

    #[test]
    fn open_with_app_accepts_only_known_editors() {
        assert_eq!(validate_editor_command("code"), Ok("code"));
        assert_eq!(validate_editor_command(" notepad++ "), Ok("notepad++"));
        assert!(validate_editor_command("/bin/sh").is_err());
        assert!(validate_editor_command("C:\\evil\\run.exe").is_err());
        assert!(validate_editor_command("").is_err());
    }

    #[test]
    fn default_app_blocks_executables_and_scripts() {
        assert!(is_executable_like(Path::new("install.ps1")));
        assert!(is_executable_like(Path::new("RUN.BAT")));
        assert!(is_executable_like(Path::new("tool.exe")));
        assert!(is_executable_like(Path::new("setup.sh")));
        assert!(!is_executable_like(Path::new("README.md")));
        assert!(!is_executable_like(Path::new("src/main.rs")));
        assert!(!is_executable_like(Path::new("Makefile")));
    }

    #[test]
    fn open_url_accepts_only_https_links() {
        assert!(validate_https_url("https://github.com/krzysztofautomatyk/ProjectToText").is_ok());
        assert!(validate_https_url("http://example.com").is_err());
        assert!(validate_https_url("file:///etc/passwd").is_err());
        assert!(validate_https_url("https://").is_err());
        assert!(validate_https_url("https://exa mple.com").is_err());
    }
}
