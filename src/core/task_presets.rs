//! Built-in task playbooks shared by CLI (`--task-preset`) and MCP (`task_preset` / prompts/*).

/// Canonical playbook ids accepted by `--task-preset` / MCP `task_preset`.
pub const TASK_PRESET_IDS: &[&str] = &[
    "architecture_audit",
    "bug_hunt",
    "security_review",
    "pr_diff_review",
    "test_generation",
];

/// Resolve a playbook id (including aliases) to task-instruction text.
pub fn resolve_task_preset(name: &str) -> Option<&'static str> {
    match name.trim() {
        "architecture_audit" | "architecture_review" => Some(
            "Perform a Principal Architecture Review of the attached project context.\n\
             Detect cyclic dependencies, layer-boundary violations, scalability risks, and technical debt.\n\
             Cite exact file paths. Prefer minimal, actionable remediation over generic advice.",
        ),
        "bug_hunt" => Some(
            "Investigate the defect using the attached sources and dependencies.\n\
             Identify the root cause (race, edge case, broken invariant), propose a minimal patch,\n\
             and include a regression test that would have caught the bug.",
        ),
        "security_review" | "security_audit" => Some(
            "Perform an AppSec / OWASP-oriented audit of the attached code.\n\
             Check path traversal, injection, authz/authn flaws, unsafe deserialization, IPC privilege\n\
             escalation, and secret exposure. Rate severity and provide remediation diffs.",
        ),
        "pr_diff_review" | "git_diff_review" => Some(
            "Review the attached project context and git changes as a strict pre-merge review.\n\
             Flag breaking changes, performance regressions, missing error handling, and test gaps.\n\
             Produce a merge-ready checklist with required follow-ups.",
        ),
        "test_generation" => Some(
            "Write a zero-hallucination unit/integration/E2E test suite for the selected modules.\n\
             Mirror existing assertion libraries and helpers in the project. Cover happy paths and edge cases.\n\
             Do not invent APIs that are not present in the pack.",
        ),
        _ => None,
    }
}

/// Human-readable description for MCP `prompts/list`.
pub fn task_preset_description(name: &str) -> Option<&'static str> {
    match name.trim() {
        "architecture_audit" | "architecture_review" => {
            Some("Principal architecture, dependency-graph, and modularity review")
        }
        "bug_hunt" => Some("Root-cause bug hunt with minimal patch and regression test"),
        "security_review" | "security_audit" => {
            Some("AppSec / OWASP audit of auth, IPC, parsers, and secret exposure")
        }
        "pr_diff_review" | "git_diff_review" => {
            Some("Strict pre-merge / git-diff impact review")
        }
        "test_generation" => {
            Some("Generate unit/E2E tests matching project helpers (zero hallucination)")
        }
        _ => None,
    }
}

/// Merge explicit `--prompt` with optional `--task-preset` (explicit prompt wins).
pub fn merge_prompt_and_preset(
    prompt: Option<String>,
    preset: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(p) = prompt.filter(|s| !s.trim().is_empty()) {
        return Ok(Some(p));
    }
    let Some(name) = preset.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    resolve_task_preset(name)
        .map(|s| Some(s.to_string()))
        .ok_or_else(|| {
            format!(
                "unknown task preset '{name}' (use {})",
                TASK_PRESET_IDS.join("|")
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_canonical_and_alias_ids() {
        assert!(resolve_task_preset("architecture_audit").is_some());
        assert_eq!(
            resolve_task_preset("architecture_audit"),
            resolve_task_preset("architecture_review")
        );
        assert!(resolve_task_preset("bug_hunt").unwrap().contains("root cause"));
        assert!(resolve_task_preset("nope").is_none());
    }

    #[test]
    fn explicit_prompt_wins_over_preset() {
        let merged = merge_prompt_and_preset(
            Some("Custom task".into()),
            Some("bug_hunt"),
        )
        .unwrap();
        assert_eq!(merged.as_deref(), Some("Custom task"));
    }
}
