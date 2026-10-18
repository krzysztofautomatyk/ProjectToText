//! Core engine (pure, testable): walker, output generation, file preview,
//! secret redaction, BPE tokenization, AST skeletonization, dependency graph, and Git context.
//! Used by the Tauri desktop app, headless CLI, and MCP server.

pub mod budget;
pub mod deps;
pub mod git;
pub mod output;
pub mod preview;
pub mod secrets;
pub mod skeleton;
pub mod task_presets;
pub mod text;
pub mod tokenizer;
pub mod walker;
pub mod workspace;
