//! Headless `ptt pack` CLI — same core engine as the desktop app.

use std::env;
use std::fs;
use std::io::{self, Write};
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
      --no-summary      Omit directory structure summary
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

pub fn maybe_run() -> bool {
    let mut argv = env::args().skip(1).collect::<Vec<_>>();
    if argv.is_empty() {
        return false;
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
        return false;
    }
    argv.remove(0);
    match parse_args(&argv) {
        Ok(args) => {
            if let Err(e) = run_pack(&args) {
                eprintln!("ptt pack: {e}");
                process::exit(1);
            }
            true
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
         Desktop:  run with no arguments (or launch the app bundle)\n\
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

    let mut buf = Vec::new();
    write_output(&mut buf, &entries, &root, &opts).map_err(|e| e.to_string())?;

    match &args.output {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            fs::write(path, &buf).map_err(|e| e.to_string())?;
            eprintln!(
                "ptt pack: wrote {} files → {} ({} bytes)",
                file_count,
                path.display(),
                buf.len()
            );
        }
        None => {
            let mut out = io::stdout().lock();
            out.write_all(&buf).map_err(|e| e.to_string())?;
            if !buf.ends_with(b"\n") {
                let _ = out.write_all(b"\n");
            }
            eprintln!(
                "ptt pack: {} files · {} bytes · {}",
                file_count,
                buf.len(),
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
    fn parse_format_aliases() {
        assert_eq!(parse_format("md").unwrap(), OutputFormat::Markdown);
        assert_eq!(parse_format("JSON").unwrap(), OutputFormat::Json);
    }
}
