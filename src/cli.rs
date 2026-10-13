//! Headless `ptt pack` CLI — same core engine as the desktop app.

use std::env;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::process;

use ptt::core::output::{write_output, OutputFormat, WriteOptions, DEFAULT_MAX_FILE_SIZE};
use ptt::core::walker::walk;

const USAGE: &str = "\
ptt pack — pack a folder into LLM-ready text (headless)

USAGE:
  ptt pack [DIR] [OPTIONS]

ARGS:
  [DIR]                 Project root (default: current directory)

OPTIONS:
  -f, --format <FMT>    xml | markdown | json | plain  (default: xml)
  -o, --output <FILE>   Write to file instead of stdout
      --no-summary      Omit XML file summary (directory listing remains)
      --max-size <N>    Per-file size limit in bytes (default: 2097152)
  -h, --help            Show this help

EXAMPLES:
  ptt pack .
  ptt pack ./my-app -f markdown -o context.md
  ptt pack . --format json --no-summary > pack.json
";

#[derive(Debug)]
struct PackArgs {
    dir: PathBuf,
    format: OutputFormat,
    output: Option<PathBuf>,
    include_summary: bool,
    max_file_size: u64,
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
         Headless: ptt pack [DIR] [OPTIONS]\n\n\
         {USAGE}",
        env!("CARGO_PKG_VERSION")
    );
}

fn parse_args(argv: &[String]) -> Result<PackArgs, String> {
    let mut dir = PathBuf::from(".");
    let mut format = OutputFormat::Xml;
    let mut output = None;
    let mut include_summary = true;
    let mut max_file_size = DEFAULT_MAX_FILE_SIZE;
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
                format = parse_format(v)?;
            }
            "-o" | "--output" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --output")?;
                output = Some(PathBuf::from(v));
            }
            "--no-summary" => include_summary = false,
            "--max-size" => {
                i += 1;
                let v = argv.get(i).ok_or("missing value for --max-size")?;
                max_file_size = v
                    .parse::<u64>()
                    .map_err(|_| format!("invalid --max-size: {v}"))?;
            }
            s if s.starts_with('-') => return Err(format!("unknown option: {s}")),
            s => {
                if positional_dir {
                    return Err(format!("unexpected argument: {s}"));
                }
                dir = PathBuf::from(s);
                positional_dir = true;
            }
        }
        i += 1;
    }

    Ok(PackArgs {
        dir,
        format,
        output,
        include_summary,
        max_file_size,
    })
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

fn run_pack(args: &PackArgs) -> Result<(), String> {
    let root = args
        .dir
        .canonicalize()
        .map_err(|e| format!("cannot open {}: {e}", args.dir.display()))?;
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }

    let entries = walk(&root).map_err(|e| e.to_string())?;
    let file_count = entries.iter().filter(|e| !e.is_dir).count();

    let opts = WriteOptions {
        format: args.format,
        include_file_summary: args.include_summary,
        max_file_size: args.max_file_size,
    };

    fn stream<W: Write>(
        writer: W,
        entries: &[ptt::DirEntryMeta],
        root: &std::path::Path,
        opts: &WriteOptions,
    ) -> Result<(), String> {
        let mut writer = BufWriter::new(writer);
        write_output(&mut writer, entries, root, opts).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
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
                if entries
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
            stream(file, &entries, &root, &opts)?;
            eprintln!("ptt pack: wrote {} files → {}", file_count, path.display());
        }
        None => {
            stream(io::stdout().lock(), &entries, &root, &opts)?;
            eprintln!(
                "ptt pack: {} files · {}",
                file_count,
                format_label(args.format)
            );
        }
    }

    Ok(())
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
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn pack_fixture_writes_xml() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("hello.rs");
        let mut f = fs::File::create(&src).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();

        let args = PackArgs {
            dir: dir.path().to_path_buf(),
            format: OutputFormat::Xml,
            output: None,
            include_summary: true,
            max_file_size: DEFAULT_MAX_FILE_SIZE,
        };
        // write to temp file instead of stdout for the test
        let out = dir.path().join("out.xml");
        let args = PackArgs {
            output: Some(out.clone()),
            ..args
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
    fn desktop_arguments_validate_folder_and_reject_typos() {
        let directory = tempdir().unwrap();
        let path = directory.path().to_string_lossy().into_owned();
        assert!(desktop_folder(&[path]).unwrap().is_some());
        assert_eq!(desktop_folder(&[]).unwrap(), None);
        assert!(desktop_folder(&["pak".into(), ".".into()]).is_err());
        assert!(desktop_folder(&["--unknown".into()]).is_err());
    }

    #[test]
    fn parse_format_aliases() {
        assert_eq!(parse_format("md").unwrap(), OutputFormat::Markdown);
        assert_eq!(parse_format("JSON").unwrap(), OutputFormat::Json);
    }
}
