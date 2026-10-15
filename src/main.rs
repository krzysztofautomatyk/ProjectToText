//! ptt — ProjectToText
//! Tauri v2 desktop app: open folder → respect .gitignore exactly like Git → pack into LLM-ready text.
//! Headless: `ptt pack [DIR] [OPTIONS]` and `ptt mcp [DIR]` (see `cli` and `mcp` modules).

// On Windows, build as a GUI app in release mode so no empty console window
// appears next to the desktop UI. In dev/debug builds we keep the console
// subsystem so `cargo run` still shows CLI output (`ptt pack ...`).
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

mod cli;
mod mcp;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

use ptt::core::deps::RelatedFiles;
use ptt::core::git::{compute_git_diff, GitRepoContext};
use ptt::core::output::{
    write_output_with_stats, FileTokenStat, OutputFormat, WriteOptions, DEFAULT_MAX_FILE_SIZE,
};
use ptt::core::preview::{load_preview, resolve_under_root, DEFAULT_PREVIEW_MAX};
use ptt::core::secrets::RedactionSummary;
use ptt::core::tokenizer::TokenizerModel;
use ptt::core::walker::{is_junk_dir_name, normalize_rel_path, DirEntryMeta, JUNK_DIRS};
use ptt::core::workspace::WorkspaceIndex;

const PREVIEW_CHAR_LIMIT: usize = 100_000;
/// Above this many queued watcher paths, the next scan walks the whole tree instead.
const MAX_PENDING_WATCHER_PATHS: usize = 4096;

/// `(modification time, length)` of a file on disk. `None` means the file does not exist.
type FileStamp = Option<(Option<SystemTime>, u64)>;

#[derive(Clone)]
struct PackedArtifact {
    revision: u64,
    generation: u64,
    /// Project root and the exact entries packed, so the pack can be rebuilt without the index.
    root: PathBuf,
    entries: Vec<DirEntryMeta>,
    options: PackOptions,
    /// One stamp per entry, read before packing. A changed stamp means the cached pack is stale.
    file_stamps: Vec<FileStamp>,
    content: Arc<String>,
    total_bytes: usize,
    total_chars: usize,
    total_tokens: usize,
    files_packed: usize,
    file_tokens: Vec<FileTokenStat>,
    redactions: RedactionSummary,
}

#[derive(Clone, Default)]
struct DesktopState {
    workspace: Arc<WorkspaceIndex>,
    startup_folder: Option<String>,
    /// Bumped by every `generate_output` call so an older pack stops at its next file.
    generation: Arc<AtomicU64>,
    /// Zero-copy cache of the latest packed artifact so Copy/Save don't round-trip MBs over IPC.
    last_artifact: Arc<Mutex<Option<PackedArtifact>>>,
    /// Optional active filesystem watcher for the currently open workspace.
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    /// Changed paths reported by the watcher since the last scan, drained by `scan_folder`.
    pending_watcher_paths: Arc<Mutex<Vec<PathBuf>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    root: String,
    revision: u64,
    nodes: Vec<FileNode>,
    junk_dirs: Vec<String>,
    git_context: GitRepoContext,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateOutputResponse {
    preview: String,
    truncated_preview: bool,
    total_bytes: usize,
    total_chars: usize,
    total_tokens: usize,
    content_tokens: usize,
    overhead_tokens: usize,
    tokenizer_exact: bool,
    files_packed: usize,
    file_tokens: Vec<FileTokenStat>,
    redactions: RedactionSummary,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_status: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PackOptions {
    pub format: String,
    pub include_summary: bool,
    pub max_file_size: Option<u64>,
    #[serde(default = "default_true")]
    pub redact_secrets: bool,
    #[serde(default)]
    pub full_preview: bool,
    #[serde(default)]
    pub skeleton_files: Vec<String>,
    #[serde(default)]
    pub include_git_diff: bool,
    #[serde(default)]
    pub task_prompt: Option<String>,
    #[serde(default)]
    pub tokenizer_model: Option<String>,
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

fn start_workspace_watcher(
    app: tauri::AppHandle,
    root: PathBuf,
    watcher_slot: Arc<Mutex<Option<RecommendedWatcher>>>,
    pending_watcher_paths: Arc<Mutex<Vec<PathBuf>>>,
) {
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(5)));
    let root_for_cb = root.clone();
    let watcher_res =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else {
                return;
            };
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            // Ignore events inside .git/ or known junk directories
            let relevant: Vec<PathBuf> = event
                .paths
                .iter()
                .filter(|p| {
                    let rel = p.strip_prefix(&root_for_cb).unwrap_or(p);
                    !rel.components().any(|c| {
                        let s = c.as_os_str().to_string_lossy();
                        is_junk_dir_name(&s)
                    })
                })
                .cloned()
                .collect();
            if relevant.is_empty() {
                return;
            }
            // Queue the paths even when the emit below is throttled, so the next scan sees them.
            if let Ok(mut pending) = pending_watcher_paths.lock() {
                if pending.len() + relevant.len() > MAX_PENDING_WATCHER_PATHS {
                    // Too many changes to track one by one: the next scan walks the whole tree.
                    pending.clear();
                    pending.push(root_for_cb.clone());
                } else {
                    pending.extend(relevant);
                }
            }
            if let Ok(mut guard) = last_emit.lock() {
                if guard.elapsed() >= Duration::from_millis(600) {
                    *guard = Instant::now();
                    let _ = app.emit(
                        "workspace-changed",
                        root_for_cb.to_string_lossy().to_string(),
                    );
                }
            }
        });

    if let Ok(mut watcher) = watcher_res {
        let _ = watcher.watch(&root, RecursiveMode::Recursive);
        if let Ok(mut slot) = watcher_slot.lock() {
            *slot = Some(watcher);
        }
    }
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
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, DesktopState>,
) -> Result<ScanResult, String> {
    let index = state.workspace.clone();
    let watcher_slot = state.watcher.clone();
    let pending = state.pending_watcher_paths.clone();
    blocking(move || {
        // In-place edits reported since the last scan are applied incrementally.
        let changed: Vec<PathBuf> = pending
            .lock()
            .map(|mut guard| std::mem::take(&mut *guard))
            .unwrap_or_default();
        let snapshot = if changed.is_empty() {
            index.scan(Path::new(&path))?
        } else {
            index.refresh_paths(Path::new(&path), &changed)?
        };
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
                let git_status = if !e.is_dir {
                    snapshot.git_context.file_statuses.get(&path_str).cloned()
                } else {
                    None
                };
                FileNode {
                    path: path_str,
                    name,
                    is_dir: e.is_dir,
                    size: e.size,
                    children: None,
                    selected: false,
                    git_status,
                }
            })
            .collect();

        start_workspace_watcher(app, snapshot.root.clone(), watcher_slot, pending);

        Ok(ScanResult {
            root: snapshot.root.to_string_lossy().into_owned(),
            revision: snapshot.revision,
            nodes,
            junk_dirs: JUNK_DIRS.iter().map(|s| (*s).to_string()).collect(),
            git_context: snapshot.git_context.clone(),
        })
    })
    .await
}

#[tauri::command]
fn startup_folder(state: tauri::State<'_, DesktopState>) -> Option<String> {
    state.startup_folder.clone()
}

fn truncate_preview_chars(s: &str, max_chars: usize) -> (String, bool) {
    let mut char_indices = s.char_indices();
    if let Some((byte_idx, _)) = char_indices.nth(max_chars) {
        (s[..byte_idx].to_string(), true)
    } else {
        (s.to_string(), false)
    }
}

fn stamp_of(path: &Path) -> FileStamp {
    std::fs::metadata(path)
        .ok()
        .map(|meta| (meta.modified().ok(), meta.len()))
}

/// Packs `entries` into the cacheable artifact and the UI response. Stamps are read before packing, so a
/// file edited while the pack runs reads as stale afterwards.
fn build_pack<F: Fn() -> bool + Sync>(
    root: PathBuf,
    entries: Vec<DirEntryMeta>,
    options: PackOptions,
    revision: u64,
    generation: u64,
    is_superseded: &F,
) -> Result<(PackedArtifact, GenerateOutputResponse), String> {
    let file_stamps = entries
        .iter()
        .map(|entry| stamp_of(&root.join(&entry.path)))
        .collect();

    let format = match options.format.as_str() {
        "markdown" => OutputFormat::Markdown,
        "json" => OutputFormat::Json,
        "plain" => OutputFormat::Plain,
        _ => OutputFormat::Xml,
    };

    let skeleton_files: HashSet<String> = options
        .skeleton_files
        .iter()
        .map(|p| normalize_rel_path(Path::new(p)))
        .collect();

    let git_diff = if options.include_git_diff {
        compute_git_diff(&root, 256 * 1024)
    } else {
        None
    };

    let tokenizer_model = options
        .tokenizer_model
        .as_deref()
        .map(TokenizerModel::parse)
        .unwrap_or(TokenizerModel::O200kBase);

    let write_opts = WriteOptions {
        format,
        include_file_summary: options.include_summary,
        max_file_size: options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE),
        redact_secrets: options.redact_secrets,
        skeleton_all: false,
        skeleton_files,
        git_diff,
        task_prompt: options.task_prompt.clone(),
        tokenizer_model,
        compute_bpe_tokens: true,
    };

    let mut buf = Vec::new();
    let pack_stats = write_output_with_stats(&mut buf, &entries, &root, &write_opts, is_superseded)
        .map_err(|e| e.to_string())?;

    let full_text =
        String::from_utf8(buf).map_err(|e| format!("Output is not valid UTF-8: {e}"))?;
    let total_bytes = full_text.len();
    let total_chars = full_text.chars().count();

    let (preview, truncated_preview) = if options.full_preview || total_chars <= 150_000 {
        (full_text.clone(), false)
    } else {
        truncate_preview_chars(&full_text, PREVIEW_CHAR_LIMIT)
    };

    let response = GenerateOutputResponse {
        preview,
        truncated_preview,
        total_bytes,
        total_chars,
        total_tokens: pack_stats.total_tokens,
        content_tokens: pack_stats.content_tokens,
        overhead_tokens: pack_stats.overhead_tokens,
        tokenizer_exact: pack_stats.tokenizer_exact,
        files_packed: pack_stats.files_packed,
        file_tokens: pack_stats.file_tokens.clone(),
        redactions: pack_stats.redactions.clone(),
    };
    let artifact = PackedArtifact {
        revision,
        generation,
        root,
        entries,
        options,
        file_stamps,
        content: Arc::new(full_text),
        total_bytes,
        total_chars,
        total_tokens: pack_stats.total_tokens,
        files_packed: pack_stats.files_packed,
        file_tokens: pack_stats.file_tokens,
        redactions: pack_stats.redactions,
    };
    Ok((artifact, response))
}

/// Returns the cached pack when every packed file still has the stamp it had when packed. Otherwise the
/// same selection is packed again from disk, and the cache is replaced.
fn ensure_fresh_artifact(state: &DesktopState) -> Result<PackedArtifact, String> {
    let cached = state
        .last_artifact
        .lock()
        .map_err(|_| "Artifact lock poisoned")?
        .clone()
        .ok_or("No packed output available")?;

    // Fail closed: when the workspace index holds a snapshot, a changed `.pttignore` or `.gitignore`
    // (or a stale revision) is an error, not a silent repack with the old selection rules.
    if state.workspace.current_snapshot().is_some() {
        state.workspace.get(&cached.root, cached.revision)?;
    }

    // Git diff content is not covered by file stamps, so a pack that includes it is rebuilt.
    let fresh = !cached.options.include_git_diff
        && cached
            .file_stamps
            .iter()
            .zip(&cached.entries)
            .all(|(stamp, entry)| *stamp == stamp_of(&cached.root.join(&entry.path)));
    if fresh {
        return Ok(cached);
    }

    let (artifact, _) = build_pack(
        cached.root.clone(),
        cached.entries.clone(),
        cached.options.clone(),
        cached.revision,
        cached.generation,
        &|| false,
    )?;
    if let Ok(mut guard) = state.last_artifact.lock() {
        *guard = Some(artifact.clone());
    }
    Ok(artifact)
}

#[tauri::command]
async fn generate_output(
    path: String,
    selected_paths: Vec<String>,
    options: PackOptions,
    revision: u64,
    state: tauri::State<'_, DesktopState>,
) -> Result<GenerateOutputResponse, String> {
    let generation = state.generation.clone();
    let request = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let index = state.workspace.clone();
    let artifact_slot = state.last_artifact.clone();

    blocking(move || {
        let snapshot = index.get(Path::new(&path), revision)?;
        let filtered = snapshot.selected(&selected_paths);
        let is_superseded = || generation.load(Ordering::SeqCst) != request;
        let (artifact, response) = build_pack(
            snapshot.root.clone(),
            filtered,
            options,
            revision,
            request,
            &is_superseded,
        )?;

        if let Ok(mut guard) = artifact_slot.lock() {
            // Only store if not superseded by a newer generation
            if generation.load(Ordering::SeqCst) == request {
                *guard = Some(artifact);
            }
        }
        Ok(response)
    })
    .await
}

#[tauri::command]
async fn get_full_packed_preview(state: tauri::State<'_, DesktopState>) -> Result<String, String> {
    let state = state.inner().clone();
    let artifact = blocking(move || ensure_fresh_artifact(&state)).await?;
    Ok((*artifact.content).clone())
}

#[tauri::command]
async fn copy_packed_output(state: tauri::State<'_, DesktopState>) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let artifact = ensure_fresh_artifact(&state)?;
        let _ = (
            artifact.revision,
            artifact.generation,
            artifact.total_bytes,
            artifact.total_chars,
            artifact.total_tokens,
            artifact.files_packed,
            &artifact.file_tokens,
            &artifact.redactions,
        );
        arboard::Clipboard::new()
            .and_then(|mut c| c.set_text((*artifact.content).clone()))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn save_packed_output(
    app: tauri::AppHandle,
    default_name: String,
    state: tauri::State<'_, DesktopState>,
) -> Result<bool, String> {
    let state = state.inner().clone();
    let artifact = blocking(move || ensure_fresh_artifact(&state)).await?;

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
                std::fs::write(&path, artifact.content.as_bytes()).map_err(|e| e.to_string())?;
                Ok(true)
            })
            .await
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn resolve_related_files(
    path: String,
    target_file: String,
    revision: u64,
    state: tauri::State<'_, DesktopState>,
) -> Result<RelatedFiles, String> {
    let index = state.workspace.clone();
    blocking(move || {
        let snapshot = index.get(Path::new(&path), revision)?;
        Ok(snapshot.dependency_graph().related_for(&target_file))
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
    })
    .await
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

    // Headless packing or MCP server without launching the GUI webview.
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
            get_full_packed_preview,
            copy_packed_output,
            save_packed_output,
            resolve_related_files,
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
    use super::*;

    #[test]
    fn stale_artifact_is_repacked_from_disk_after_a_selected_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("note.txt"), "old").unwrap();
        let entries: Vec<DirEntryMeta> = ptt::core::walker::walk(&root)
            .unwrap()
            .into_iter()
            .filter(|e| !e.is_dir)
            .collect();
        let options = PackOptions {
            format: "plain".into(),
            include_summary: false,
            max_file_size: None,
            redact_secrets: true,
            full_preview: true,
            skeleton_files: Vec::new(),
            include_git_diff: false,
            task_prompt: None,
            tokenizer_model: None,
        };
        let (artifact, _) = build_pack(root.clone(), entries, options, 1, 1, &|| false).unwrap();
        let state = DesktopState {
            last_artifact: Arc::new(Mutex::new(Some(artifact.clone()))),
            ..Default::default()
        };

        // Unchanged files: the cached pack is returned as is.
        let reused = ensure_fresh_artifact(&state).unwrap();
        assert!(Arc::ptr_eq(&reused.content, &artifact.content));

        // A selected file changed on disk: the pack is rebuilt from the new content.
        std::fs::write(root.join("note.txt"), "brand new content").unwrap();
        let fresh = ensure_fresh_artifact(&state).unwrap();
        assert!(
            fresh.content.contains("brand new content"),
            "{}",
            fresh.content
        );
        assert!(!Arc::ptr_eq(&fresh.content, &artifact.content));
    }

    #[test]
    fn stale_artifact_fails_closed_when_ignore_rules_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("note.txt"), "old").unwrap();
        let state = DesktopState::default();
        let snapshot = state.workspace.scan(&root).unwrap();
        let options = PackOptions {
            format: "plain".into(),
            include_summary: false,
            max_file_size: None,
            redact_secrets: true,
            full_preview: true,
            skeleton_files: Vec::new(),
            include_git_diff: false,
            task_prompt: None,
            tokenizer_model: None,
        };
        let entries = snapshot
            .entries
            .iter()
            .filter(|e| !e.is_dir)
            .cloned()
            .collect();
        let (artifact, _) = build_pack(
            root.clone(),
            entries,
            options,
            snapshot.revision,
            1,
            &|| false,
        )
        .unwrap();
        *state.last_artifact.lock().unwrap() = Some(artifact);
        assert!(ensure_fresh_artifact(&state).is_ok());

        // A new ignore file changes which files a pack may contain: the cache must not be reused.
        std::fs::write(root.join(".pttignore"), "note.txt\n").unwrap();
        let error = ensure_fresh_artifact(&state).err().unwrap();
        assert_eq!(
            error,
            "Ignore rules changed; refresh the project before packing"
        );
    }

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
