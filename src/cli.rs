//! Headless `ptt pack` and `ptt mcp` CLI — same core engine as the desktop app.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process;

use globset::{Glob, GlobSet, GlobSetBuilder};
use ptt::core::budget::{fit_to_bpe_budget_with_pins, prefit_by_estimate};
use ptt::core::git::{compute_git_diff, inspect_git_context};
use ptt::core::output::{
    write_output_with_stats, OutputFormat, WriteOptions, DEFAULT_MAX_FILE_SIZE,
};
use ptt::core::tokenizer::TokenizerModel;
use ptt::core::walker::{
    is_default_excluded_path, is_junk_dir_name, normalize_rel_path, walk, DirEntryMeta,
};

const USAGE: &str = "\
ptt pack — pack a folder into LLM-ready text (headless)
ptt mcp  — run Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio

USAGE:
  ptt pack [DIR] [OPTIONS]
  ptt mcp [DIR]

ARGS:
  [DIR]                   Project root (default: current directory)

OPTIONS:
  -f, --format <FMT>      xml | markdown | json | plain  (default: xml)
  -o, --output <FILE>     Write to file instead of stdout
  -c, --copy              Copy packed output directly to system clipboard
      --preset <PRESET>   source | docs | all
      --pin <PATH>        Pin a project file so --max-tokens fitting never drops it (repeatable)
      --include <GLOB>    Include only files matching glob (repeatable)
      --exclude <GLOB>    Exclude files matching glob (repeatable)
      --skeleton [GLOB]   Pack all files (or files matching GLOB) as AST skeletons
      --git-modified      Select only Git modified / staged / untracked files
      --git-branch        Select only files changed on current branch vs base branch
      --git-diff          Include unified <git_diff> in packed output
      --max-tokens <N>    Fit the pack within N tokens (strict final-artifact limit)
      --tokenizer <MODEL> o200k_base | cl100k_base | claude | gemini (default: o200k_base)
      --no-redact         Disable automatic secret redaction
      --no-summary        Omit XML file summary (directory listing remains)
      --max-size <N>      Per-file size limit in bytes (default: 2097152)
      --prompt <TEXT>     Append <task_instructions> prompt at the end of the pack
  -h, --help              Show this help

EXAMPLES:
  ptt pack .
  ptt pack ./my-app -f markdown -o context.md
  ptt pack . --preset source --skeleton --max-tokens 128000 -c
  ptt pack . --git-modified --git-diff
  ptt mcp .
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliPreset {
    Source,
    Docs,
    All,
}

#[derive(Debug)]
pub struct PackArgs {
    pub dir: PathBuf,
    pub format: OutputFormat,
    pub output: Option<PathBuf>,
    pub copy_to_clipboard: bool,
    pub include_summary: bool,
    pub max_file_size: u64,
    pub preset: Option<CliPreset>,
    pub pinned_paths: Vec<String>,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub skeleton: bool,
    pub skeleton_globs: Vec<String>,
    pub git_modified: bool,
    pub git_branch: bool,
    pub git_diff: bool,
    pub max_tokens: Option<usize>,
    pub tokenizer_model: TokenizerModel,
    pub redact_secrets: bool,
    pub task_prompt: Option<String>,
}

impl Default for PackArgs {
    fn default() -> Self {
        Self {
            dir: PathBuf::from("."),
            format: OutputFormat::Xml,
            output: None,
            copy_to_clipboard: false,
            include_summary: true,
            max_file_size: DEFAULT_MAX_FILE_SIZE,
            preset: None,
            pinned_paths: Vec::new(),
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            skeleton: false,
            skeleton_globs: Vec::new(),
            git_modified: false,
            git_branch: false,
            git_diff: false,
            max_tokens: None,
            tokenizer_model: TokenizerModel::O200kBase,
            redact_secrets: true,
            task_prompt: None,
        }
    }
}

pub enum Launch {
    Headless,
    Desktop(Option<String>),
}

fn desktop_folder(argv: &[String]) -> Result<Option<String>, String> {
    if argv.is_empty() {
        return Ok(None);
    }
    if argv.len() != 1 || argv[0].starts_with('-') {
        return Err("Use ptt [DIR] for desktop or ptt pack [DIR] [OPTIONS]".into());
    }
    let path = PathBuf::from(&argv[0]);
    if !path.is_dir() {
        return Err(format!("Unknown command or invalid directory: {}", argv[0]));
    }
    Ok(Some(
        path.canonicalize()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned(),
    ))
}

pub fn maybe_run() -> Launch {
    let mut argv = env::args().skip(1).collect::<Vec<_>>();
    if argv.is_empty() {
        return Launch::Desktop(None);
    }
    let cmd = argv[0].as_str();
    if cmd == "mcp" || cmd == "--mcp" {
        argv.remove(0);
        let dir = argv
            .first()
            .filter(|s| !s.starts_with('-'))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        if argv.iter().any(|a| a == "-h" || a == "--help") {
            print!("{USAGE}");
            process::exit(0);
        }
        if let Err(e) = crate::mcp::run_mcp_stdio(dir) {
            eprintln!("ptt mcp: {e}");
            process::exit(1);
        }
        return Launch::Headless;
    }

    if cmd != "pack" && cmd != "--pack" {
        if matches!(cmd, "-h" | "--help") {
            print_top_help();
            process::exit(0);
        }
        if matches!(cmd, "-V" | "--version") {
            println!("ptt {}", env!("CARGO_PKG_VERSION"));
            process::exit(0);
        }
        return match desktop_folder(&argv) {
            Ok(folder) => Launch::Desktop(folder),
            Err(error) => {
                eprintln!("ptt: {error}");
                process::exit(2);
            }
        };
    }
    argv.remove(0);
    match parse_args(&argv) {
        Ok(args) => {
            if let Err(e) = run_pack(&args) {
                eprintln!("ptt pack: {e}");
                process::exit(1);
            }
            Launch::Headless
        }
        Err(e) => {
            eprintln!("ptt pack: {e}\n\n{USAGE}");
            process::exit(2);
        }
    }
}

fn print_top_help() {
    println!(
        "ptt {} — ProjectToText\n\n\
         Desktop:  ptt [DIR] (or launch the app bundle)\n\
         Headless: ptt pack [DIR] [OPTIONS]\n\
         MCP:      ptt mcp [DIR]\n\n\
         {USAGE}",
        env!("CARGO_PKG_VERSION")
    );
}

pub fn parse_args(argv: &[String]) -> Result<PackArgs, String> {
    let mut args = PackArgs::default();
    let mut positional_dir = false;

    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "-h" | "--help" => {
                print!("{USAGE}");
                process::exit(0);
            }
            "-f" | "--format" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --format")?;
                args.format = parse_format(v)?;
            }
            "-o" | "--output" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --output")?;
                args.output = Some(PathBuf::from(v));
            }
            "-c" | "--copy" => {
                args.copy_to_clipboard = true;
            }
            "--preset" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --preset")?;
                args.preset = Some(parse_preset(v)?);
            }
            "--pin" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --pin")?;
                args.pinned_paths.push(v.clone());
            }
            "--include" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --include")?;
                args.include_globs.push(v.clone());
            }
            "--exclude" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --exclude")?;
                args.exclude_globs.push(v.clone());
            }
            "--skeleton" | "--skeleton-all" => {
                // Support both `--skeleton` (all files) and `--skeleton <GLOB>` (when next token is a glob pattern)
                if a == "--skeleton" {
                    if let Some(next) = argv.get(i + 1) {
                        if !next.starts_with('-')
                            && (next.contains('*') || next.contains('?') || next.contains('['))
                        {
                            i += 1;
                            args.skeleton_globs.push(next.clone());
                        } else {
                            args.skeleton = true;
                        }
                    } else {
                        args.skeleton = true;
                    }
                } else {
                    args.skeleton = true;
                }
            }
            "--git-modified" => {
                args.git_modified = true;
            }
            "--git-branch" => {
                args.git_branch = true;
            }
            "--git-diff" => {
                args.git_diff = true;
            }
            "--max-tokens" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --max-tokens")?;
                let parsed = v
                    .parse::<usize>()
                    .map_err(|_| format!("invalid --max-tokens: {v}"))?;
                if parsed == 0 {
                    return Err("--max-tokens must be greater than 0".into());
                }
                args.max_tokens = Some(parsed);
            }
            "--tokenizer" | "--model" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --tokenizer")?;
                args.tokenizer_model = TokenizerModel::try_parse(v)?;
            }
            "--no-redact" => {
                args.redact_secrets = false;
            }
            "--no-summary" => args.include_summary = false,
            "--max-size" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --max-size")?;
                args.max_file_size = v
                    .parse::<u64>()
                    .map_err(|_| format!("invalid --max-size: {v}"))?;
            }
            "--prompt" | "--task" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --prompt")?;
                args.task_prompt = Some(v.clone());
            }
            s if s.starts_with('-') => return Err(format!("unknown option: {s}")),
            s => {
                if positional_dir {
                    return Err(format!("unexpected argument: {s}"));
                }
                args.dir = PathBuf::from(s);
                positional_dir = true;
            }
        }
        i += 1;
    }

    Ok(args)
}

fn parse_format(s: &str) -> Result<OutputFormat, String> {
    match s.to_ascii_lowercase().as_str() {
        "xml" => Ok(OutputFormat::Xml),
        "markdown" | "md" => Ok(OutputFormat::Markdown),
        "json" => Ok(OutputFormat::Json),
        "plain" | "txt" | "text" => Ok(OutputFormat::Plain),
        other => Err(format!(
            "unknown format '{other}' (use xml|markdown|json|plain)"
        )),
    }
}

pub(crate) fn parse_preset(s: &str) -> Result<CliPreset, String> {
    match s.to_ascii_lowercase().as_str() {
        "source" | "src" => Ok(CliPreset::Source),
        "docs" | "doc" => Ok(CliPreset::Docs),
        "all" | "clean" => Ok(CliPreset::All),
        other => Err(format!("unknown preset '{other}' (use source|docs|all)")),
    }
}

const SOURCE_EXTS: &[&str] = &[
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".vue",
    ".svelte",
    ".rs",
    ".go",
    ".py",
    ".java",
    ".cpp",
    ".c",
    ".h",
    ".hpp",
    ".cs",
    ".fs",
    ".fsx",
    ".fsi",
    ".vb",
    ".xaml",
    ".axaml",
    ".razor",
    ".cshtml",
    ".csproj",
    ".fsproj",
    ".vbproj",
    ".sln",
    ".props",
    ".targets",
    ".resx",
    ".editorconfig",
    ".md",
    ".txt",
    ".json",
    ".jsonc",
    ".toml",
    ".yaml",
    ".yml",
    ".xml",
    ".css",
    ".scss",
    ".html",
    ".sql",
    ".sh",
    ".ps1",
    ".rb",
    ".kt",
    ".swift",
];

const DOC_EXTS: &[&str] = &[".md", ".txt", ".rst", ".adoc"];

fn is_source_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if SOURCE_EXTS.iter().any(|ext| lower.ends_with(ext)) {
        return true;
    }
    lower.ends_with(".xaml.cs") || lower.ends_with(".razor.cs") || lower.ends_with(".designer.cs")
}

fn is_junk_rel_path(path: &str) -> bool {
    path.split('/').any(is_junk_dir_name)
}

fn matches_preset(path: &str, preset: CliPreset) -> bool {
    if is_junk_rel_path(path) || is_default_excluded_path(path) {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    match preset {
        CliPreset::All => true,
        CliPreset::Docs => is_source_path(path) || DOC_EXTS.iter().any(|ext| lower.ends_with(ext)),
        CliPreset::Source => is_source_path(path),
    }
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for pat in patterns {
        let glob = Glob::new(pat).map_err(|e| format!("invalid glob '{pat}': {e}"))?;
        builder.add(glob);
    }
    builder
        .build()
        .map(Some)
        .map_err(|e| format!("failed to build globset: {e}"))
}

impl PackArgs {
    /// The `--pin` paths in the normalized form the budget fitter compares against.
    pub(crate) fn pinned_rel_paths(&self) -> HashSet<String> {
        self.pinned_paths
            .iter()
            .map(|p| normalize_rel_path(Path::new(p)))
            .collect()
    }
}

/// Filters and auto-fits `entries` according to `args`. Returns `(filtered_entries, skeleton_files)`.
pub fn filter_entries_for_cli(
    entries: Vec<DirEntryMeta>,
    root: &Path,
    args: &PackArgs,
) -> Result<(Vec<DirEntryMeta>, HashSet<String>), String> {
    let include_set = build_globset(&args.include_globs)?;
    let exclude_set = build_globset(&args.exclude_globs)?;
    let skeleton_glob_set = build_globset(&args.skeleton_globs)?;

    let git_mod_set: Option<HashSet<String>> = if args.git_modified || args.git_branch {
        let ctx = inspect_git_context(root);
        let mut set = HashSet::new();
        if args.git_modified {
            set.extend(ctx.modified_files);
        }
        if args.git_branch {
            set.extend(ctx.branch_changed_files);
        }
        Some(set)
    } else {
        None
    };

    let mut files: Vec<DirEntryMeta> = entries
        .into_iter()
        .filter(|e| {
            if e.is_dir {
                return false;
            }
            let rel = normalize_rel_path(&e.path);
            let file_name = e
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(rel.as_str());

            if let Some(preset) = args.preset {
                if !matches_preset(&rel, preset) {
                    return false;
                }
            }
            if let Some(ref gset) = git_mod_set {
                if !gset.contains(&rel) {
                    return false;
                }
            }
            if let Some(ref inc) = include_set {
                if !inc.is_match(&rel) && !inc.is_match(file_name) {
                    return false;
                }
            }
            if let Some(ref exc) = exclude_set {
                if exc.is_match(&rel) || exc.is_match(file_name) {
                    return false;
                }
            }
            true
        })
        .collect();

    let mut skeleton_files = HashSet::new();
    if let Some(ref skel_set) = skeleton_glob_set {
        for f in &files {
            let rel = normalize_rel_path(&f.path);
            let file_name = f
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(rel.as_str());
            if skel_set.is_match(&rel) || skel_set.is_match(file_name) {
                skeleton_files.insert(rel);
            }
        }
    }

    if let Some(budget) = args.max_tokens {
        files = prefit_by_estimate(
            files,
            &mut skeleton_files,
            args.skeleton,
            budget,
            &args.pinned_rel_paths(),
        );
    }

    Ok((files, skeleton_files))
}

/// One-line pre-export redaction report for stderr. Says what was masked, what was skipped, and
/// that pattern matching is not a guarantee. Redaction off is stated explicitly.
fn redaction_report(stats: &ptt::PackStats) -> String {
    let r = &stats.redactions;
    if !r.redaction_enabled {
        return "ptt pack: redaction OFF (--no-redact): credentials in selected files and the diff are included unmasked".to_string();
    }
    let kinds = if r.kinds.is_empty() {
        "no pattern matched".to_string()
    } else {
        r.kinds
            .iter()
            .map(|(kind, count)| format!("{kind}×{count}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "ptt pack: redaction ON: {} masked ({kinds}); {} files scanned, {} skipped. Pattern-based only: no match does not prove there are no secrets",
        r.total_redactions, r.files_scanned, r.files_skipped
    )
}

pub fn run_pack(args: &PackArgs) -> Result<(), String> {
    let root = args
        .dir
        .canonicalize()
        .map_err(|e| format!("cannot open {}: {e}", args.dir.display()))?;
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }

    let entries = walk(&root).map_err(|e| e.to_string())?;
    let (filtered_entries, skeleton_files) = filter_entries_for_cli(entries, &root, args)?;
    let git_diff = if args.git_diff {
        compute_git_diff(&root, 256 * 1024)
    } else {
        None
    };

    let pinned_rel_paths = args.pinned_rel_paths();

    let mut opts = WriteOptions {
        format: args.format,
        include_file_summary: args.include_summary,
        max_file_size: args.max_file_size,
        redact_secrets: args.redact_secrets,
        skeleton_all: args.skeleton,
        skeleton_files,
        git_diff,
        task_prompt: args.task_prompt.clone(),
        tokenizer_model: args.tokenizer_model,
        compute_bpe_tokens: true,
    };

    // `--max-tokens` is a hard limit on the exact BPE count, not only on the heuristic estimate.
    let filtered_entries = match args.max_tokens {
        Some(budget) => {
            let (entries, skeleton_files) = fit_to_bpe_budget_with_pins(
                filtered_entries,
                &root,
                &opts,
                budget,
                &pinned_rel_paths,
            )?;
            opts.skeleton_files = skeleton_files;
            entries
        }
        None => filtered_entries,
    };
    let file_count = filtered_entries.iter().filter(|e| !e.is_dir).count();

    if args.copy_to_clipboard {
        let mut buf = Vec::new();
        let stats = write_output_with_stats(&mut buf, &filtered_entries, &root, &opts, &|| false)
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8(buf).map_err(|e| e.to_string())?;

        if let Some(path) = &args.output {
            write_to_dest_file(path, &root, &filtered_entries, text.as_bytes())?;
        }

        arboard::Clipboard::new()
            .and_then(|mut c| c.set_text(text))
            .map_err(|e| format!("clipboard error: {e}"))?;
        let tok_prefix = if stats.tokenizer_exact { "" } else { "~" };
        eprintln!(
            "ptt pack: copied {} files ({}{} tokens, {}) to clipboard",
            file_count,
            tok_prefix,
            stats.total_tokens,
            opts.tokenizer_model.label()
        );
        eprintln!("{}", redaction_report(&stats));
        return Ok(());
    }

    fn stream<W: Write>(
        writer: W,
        entries: &[DirEntryMeta],
        root: &Path,
        opts: &WriteOptions,
    ) -> Result<ptt::PackStats, String> {
        let mut writer = BufWriter::new(writer);
        let stats = write_output_with_stats(&mut writer, entries, root, opts, &|| false)
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
        Ok(stats)
    }

    match &args.output {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            if path.exists() {
                let destination = path.canonicalize().map_err(|error| error.to_string())?;
                if filtered_entries
                    .iter()
                    .any(|entry| !entry.is_dir && root.join(&entry.path) == destination)
                {
                    return Err(
                        "Output is also an input file; place it outside the project or ignore it"
                            .into(),
                    );
                }
            }
            let file = fs::File::create(path).map_err(|error| error.to_string())?;
            let stats = stream(file, &filtered_entries, &root, &opts)?;
            let tok_prefix = if stats.tokenizer_exact { "" } else { "~" };
            eprintln!(
                "ptt pack: wrote {} files ({}{} tokens, {}) → {}",
                file_count,
                tok_prefix,
                stats.total_tokens,
                opts.tokenizer_model.label(),
                path.display()
            );
            eprintln!("{}", redaction_report(&stats));
        }
        None => {
            let stats = stream(io::stdout().lock(), &filtered_entries, &root, &opts)?;
            let tok_prefix = if stats.tokenizer_exact { "" } else { "~" };
            eprintln!(
                "ptt pack: {} files · {}{} tokens ({}) · {}",
                file_count,
                tok_prefix,
                stats.total_tokens,
                opts.tokenizer_model.label(),
                format_label(args.format)
            );
            eprintln!("{}", redaction_report(&stats));
        }
    }

    Ok(())
}

fn write_to_dest_file(
    path: &Path,
    root: &Path,
    entries: &[DirEntryMeta],
    bytes: &[u8],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    if path.exists() {
        let destination = path.canonicalize().map_err(|error| error.to_string())?;
        if entries
            .iter()
            .any(|entry| !entry.is_dir && root.join(&entry.path) == destination)
        {
            return Err(
                "Output is also an input file; place it outside the project or ignore it".into(),
            );
        }
    }
    fs::write(path, bytes).map_err(|e| e.to_string())
}

fn format_label(f: OutputFormat) -> &'static str {
    match f {
        OutputFormat::Xml => "xml",
        OutputFormat::Markdown => "markdown",
        OutputFormat::Json => "json",
        OutputFormat::Plain => "plain",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ptt::core::budget::{fit_to_bpe_budget, pack_stats};
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn pack_fixture_writes_xml() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("hello.rs");
        let mut f = fs::File::create(&src).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();

        let out = dir.path().join("out.xml");
        let args = PackArgs {
            dir: dir.path().to_path_buf(),
            output: Some(out.clone()),
            ..Default::default()
        };
        run_pack(&args).unwrap();
        let text = fs::read_to_string(&out).unwrap();
        assert!(
            text.contains("hello.rs") || text.contains("project"),
            "{text}"
        );
        assert!(
            text.contains("fn main") || text.contains("CDATA") || text.contains("file"),
            "{text}"
        );
    }

    #[test]
    fn cli_flags_parse_and_filter_correctly() {
        let argv: Vec<String> = vec![
            "./my-app",
            "--preset",
            "source",
            "--include",
            "*.rs",
            "--exclude",
            "*_test.rs",
            "--skeleton",
            "--no-redact",
            "--max-tokens",
            "64000",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let parsed = parse_args(&argv).unwrap();
        assert_eq!(parsed.preset, Some(CliPreset::Source));
        assert_eq!(parsed.include_globs, vec!["*.rs"]);
        assert_eq!(parsed.exclude_globs, vec!["*_test.rs"]);
        assert!(parsed.skeleton);
        assert!(!parsed.redact_secrets);
        assert_eq!(parsed.max_tokens, Some(64000));

        // Also verify `--skeleton <GLOB>` selective skeletonization
        let argv_glob: Vec<String> = vec!["--skeleton", "*_test.rs", "./my-app"]
            .into_iter()
            .map(String::from)
            .collect();
        let parsed_glob = parse_args(&argv_glob).unwrap();
        assert!(!parsed_glob.skeleton);
        assert_eq!(parsed_glob.skeleton_globs, vec!["*_test.rs"]);
        assert_eq!(parsed_glob.dir, PathBuf::from("./my-app"));
    }

    #[test]
    fn desktop_arguments_validate_folder_and_reject_typos() {
        let directory = tempdir().unwrap();
        let path = directory.path().to_string_lossy().into_owned();
        assert!(desktop_folder(&[path]).unwrap().is_some());
        assert_eq!(desktop_folder(&[]).unwrap(), None);
        assert!(desktop_folder(&["pak".into(), ".".into()]).is_err());
        assert!(desktop_folder(&["--unknown".into()]).is_err());
    }

    #[test]
    fn max_tokens_is_enforced_on_the_exact_bpe_count() {
        let dir = tempdir().unwrap();
        for i in 0..8 {
            let body: String = (0..120)
                .map(|j| format!("pub fn item_{i}_{j}(value: u64) -> u64 {{ value + {j} }}\n"))
                .collect();
            fs::write(dir.path().join(format!("module_{i}.rs")), body).unwrap();
        }
        let root = dir.path().canonicalize().unwrap();
        let budget: usize = 4_000;
        let args = PackArgs {
            dir: root.clone(),
            max_tokens: Some(budget),
            ..Default::default()
        };
        let entries = walk(&root).unwrap();
        let (filtered, skeleton_files) = filter_entries_for_cli(entries, &root, &args).unwrap();
        let opts = WriteOptions {
            skeleton_files,
            compute_bpe_tokens: true,
            ..Default::default()
        };
        let (fitted, fit_skeletons) = fit_to_bpe_budget(filtered, &root, &opts, budget).unwrap();

        let opts = WriteOptions {
            skeleton_files: fit_skeletons.clone(),
            ..opts
        };
        let stats = pack_stats(&fitted, &root, &opts).unwrap();
        assert!(
            stats.total_tokens <= budget,
            "pack has {} tokens for budget {budget}",
            stats.total_tokens
        );
        assert!(!fitted.is_empty(), "no file kept");
        assert!(
            fitted.len() < 8 || !fit_skeletons.is_empty(),
            "budget {budget} forced neither a drop nor a skeleton"
        );
    }

    #[test]
    fn parse_format_aliases() {
        assert_eq!(parse_format("md").unwrap(), OutputFormat::Markdown);
        assert_eq!(parse_format("JSON").unwrap(), OutputFormat::Json);
    }
}
