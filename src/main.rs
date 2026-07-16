// ptt — ProjectToText
// Tauri v2 desktop app: open folder → respect .gitignore exactly like Git → pack into LLM-ready text.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

mod core;

use core::output::{WriteOptions, DEFAULT_MAX_FILE_SIZE};
use core::walker::{normalize_rel_path, path_is_selected};

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

    let entries = core::walker::walk(&root).map_err(|e| e.to_string())?;

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
                selected: false, // frontend applies smart defaults + user selection
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

    let entries = core::walker::walk(&root).map_err(|e| e.to_string())?;

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
        "markdown" => core::output::OutputFormat::Markdown,
        "json" => core::output::OutputFormat::Json,
        "plain" => core::output::OutputFormat::Plain,
        _ => core::output::OutputFormat::Xml,
    };

    let write_opts = WriteOptions {
        format,
        include_file_summary: options.include_summary,
        max_file_size: options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE),
    };

    // relative_paths is always true for packed output (absolute roots stay only in metadata).
    let _ = options.relative_paths;

    let mut buf = Vec::new();
    core::output::write_output(&mut buf, &filtered, &root, &write_opts)
        .map_err(|e| e.to_string())?;

    String::from_utf8(buf).map_err(|e| format!("Output is not valid UTF-8: {e}"))
}

#[tauri::command]
async fn copy_to_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

/// Returns `true` if the user confirmed a path and the file was written.
/// Returns `false` if the save dialog was cancelled.
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            select_folder,
            scan_folder,
            generate_output,
            copy_to_clipboard,
            save_to_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
