//! ptt — ProjectToText
//! Tauri v2 desktop app: open folder → respect .gitignore exactly like Git → pack into LLM-ready text.
//! Headless: `ptt pack [DIR] [OPTIONS]` (see `cli` module).

mod cli;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

use ptt::core::output::OutputFormat;
use ptt::core::output::{WriteOptions, DEFAULT_MAX_FILE_SIZE};
use ptt::core::preview::{load_preview, resolve_under_root, DEFAULT_PREVIEW_MAX};
use ptt::core::walker::{normalize_rel_path, path_is_selected, walk};

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
    pub relative_paths: bool,
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
async fn scan_folder(path: String) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    let entries = walk(&root).map_err(|e| e.to_string())?;

    let nodes: Vec<FileNode> = entries
        .into_iter()
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

    Ok(nodes)
}

#[tauri::command]
async fn generate_output(
    path: String,
    selected_paths: Vec<String>,
    options: PackOptions,
) -> Result<String, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    let entries = walk(&root).map_err(|e| e.to_string())?;

    let selected_norm: Vec<String> = selected_paths
        .iter()
        .map(|p| p.replace('\\', "/").trim_end_matches('/').to_string())
        .filter(|p| !p.is_empty())
        .collect();

    let filtered: Vec<_> = entries
        .into_iter()
        .filter(|e| {
            if e.is_dir {
                return false;
            }
            selected_norm.iter().any(|sp| path_is_selected(&e.path, sp))
        })
        .collect();

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

    let _ = options.relative_paths;

    let mut buf = Vec::new();
    ptt::write_output(&mut buf, &filtered, &root, &write_opts).map_err(|e| e.to_string())?;

    String::from_utf8(buf).map_err(|e| format!("Output is not valid UTF-8: {e}"))
}

#[tauri::command]
async fn read_file_preview(
    root: String,
    relative_path: String,
    max_bytes: Option<u64>,
) -> Result<FilePreviewDto, String> {
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
}

/// Open a project file with the OS default application.
#[tauri::command]
async fn open_in_default_app(root: String, relative_path: String) -> Result<(), String> {
    let full =
        resolve_under_root(&PathBuf::from(&root), &relative_path).map_err(|e| e.to_string())?;
    open::that(&full).map_err(|e| format!("Failed to open file: {e}"))
}

/// Open a project file with a specific application / shell command
/// (e.g. `code`, `notepad++`, full path to an `.exe` / `.app`).
#[tauri::command]
async fn open_with_app(root: String, relative_path: String, app: String) -> Result<(), String> {
    let full =
        resolve_under_root(&PathBuf::from(&root), &relative_path).map_err(|e| e.to_string())?;
    let app = app.trim();
    if app.is_empty() {
        return Err("Application path/command is empty".into());
    }
    open::with(&full, app).map_err(|e| format!("Failed to open with {app}: {e}"))
}

/// Pick an application via file dialog, then open the project file with it.
/// Returns `true` if opened, `false` if the dialog was cancelled.
#[tauri::command]
async fn pick_app_and_open(
    app_handle: tauri::AppHandle,
    root: String,
    relative_path: String,
) -> Result<bool, String> {
    let full =
        resolve_under_root(&PathBuf::from(&root), &relative_path).map_err(|e| e.to_string())?;

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
            open::with(&full, &app_path)
                .map_err(|e| format!("Failed to open with selected app: {e}"))?;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn copy_to_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
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
            std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    // Headless packing without launching the GUI webview.
    if cli::maybe_run() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            select_folder,
            scan_folder,
            generate_output,
            read_file_preview,
            open_in_default_app,
            open_with_app,
            pick_app_and_open,
            copy_to_clipboard,
            save_to_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
