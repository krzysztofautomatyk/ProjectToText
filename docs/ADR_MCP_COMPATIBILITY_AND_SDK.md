# Architecture Decision Record: MCP Protocol Compatibility and SDK Strategy

**Status:** Accepted  
**Deciders:** Chief Architect, Staff Rust Engineer, MCP Protocol Engineer, AppSec / Privacy Reviewer  
**Date:** 2026-10-17  
**Consulted primary specifications (verified 2026-10-17):**
- [MCP Specification: Versioning & Lifecycle](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP Specification: Changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP Specification: Server Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Official Model Context Protocol Rust SDK (`rmcp`)](https://github.com/modelcontextprotocol/rust-sdk)
- [MCP Conformance Test Suite](https://github.com/modelcontextprotocol/conformance)

---

## 1. Context and Problem Statement

ProjectToText includes a built-in Model Context Protocol (MCP) server executed via `ptt mcp [DIR]`. It enables AI desktop tools (Claude Desktop, Claude Code, Cursor, Zed, Windsurf, etc.) to inspect repository structure, pack files under token budgets, query related symbols, retrieve git diffs, and inspect prompts over `stdio`.

In the current code (`src/mcp.rs`), the server negotiates:
```rust
pub const SUPPORTED_MCP_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2024-11-05"];
const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const LATEST_MCP_PROTOCOL_VERSION: &str = "2025-11-25";
```

The MCP Working Group published revision `2026-07-28`. Two questions must be formally addressed:
1. **Protocol Compliance:** Can or should ProjectToText advertise `2026-07-28` today?
2. **SDK Migration:** Should ProjectToText replace its custom JSON-RPC/stdio implementation with the official Rust SDK (`rmcp`)?

---

## 2. Analysis of MCP Revision `2026-07-28`

The `2026-07-28` specification introduces breaking architectural changes to the protocol transport and lifecycle contracts:

| Protocol Aspect | Revisions `2024-11-05` .. `2025-11-25` | Revision `2026-07-28` | Impact on ProjectToText |
|---|---|---|---|
| **Lifecycle Handshake** | Strict `initialize` request followed by `notifications/initialized`. Protocol version negotiated once during handshake. | **Removed initialization handshake.** Clients issue requests immediately. Discovery performed via `server/discover`. | Breaking. `src/mcp.rs` enforces initialization state machine. Advertising `2026-07-28` while expecting `initialize` violates spec. |
| **Protocol Negotiation** | `initialize.params.protocolVersion` string. Echoed in `initialize.result.protocolVersion`. | Per-request `_meta.protocolVersion` metadata object attached to every JSON-RPC message. | Breaking. Requires parsing `_meta` across all methods and dynamically adapting response framing per message. |
| **Discovery** | `tools/list`, `resources/list`, `prompts/list` called separately after handshake. | `server/discover` unified discovery endpoint returning capabilities, tools, resources, and prompts in a single schema. | Significant change. Server must support `server/discover`. |
| **Tool Response Types** | `result.content: [{type: "text", text: "..."}]` with optional `isError: bool`. | Mandatory `resultType` field specifying structure, content envelope, and error categorizations. | Breaking payload schema change. |
| **Cache & Chunking** | Ad-hoc or tool-specific metadata. | Standardized cache control headers and token budget metadata in `_meta`. | Moderate. |

### Conclusion on `2026-07-28`
Simply adding `"2026-07-28"` to `SUPPORTED_MCP_VERSIONS` would be dishonest and fail immediately against compliant `2026-07-28` clients. It would also break existing clients (Claude Desktop, Cursor) that continue to rely on the stable `initialize` handshake from `2024-11-05` and `2025-11-25`.

---

## 3. Protocol Compatibility Matrix

The table below defines ProjectToText's explicit compatibility guarantees:

| Method / Message | `2024-11-05` | `2025-06-18` | `2025-11-25` | `2026-07-28` (Current State) |
|---|---|---|---|---|
| `initialize` | Supported (Default) | Supported | Supported (Latest) | **Not supported** (Spec removed this) |
| `notifications/initialized` | Supported (No-op ack) | Supported | Supported | **Not supported** |
| `server/discover` | N/A (Not in spec) | N/A | N/A | **Unimplemented** |
| `tools/list` | Supported | Supported | Supported + Read-only annotations | Needs `_meta` & `resultType` |
| `tools/call` (`ptt_pack_files`) | Supported | Supported | Supported + Strict BPE budget & pins | Needs `_meta` & `resultType` |
| `tools/call` (`ptt_get_project_map`) | Supported | Supported | Supported | Needs `_meta` & `resultType` |
| `tools/call` (`ptt_get_git_context`) | Supported | Supported | Supported | Needs `_meta` & `resultType` |
| `tools/call` (`ptt_get_related_files`) | Supported | Supported | Supported | Needs `_meta` & `resultType` |
| `tools/call` (`ptt_search_symbols`) | Supported | Supported | Supported | Needs `_meta` & `resultType` |
| `resources/list` & `resources/read` | Ignored / N/A | Supported | Supported (`ptt://project/*`) | Needs unified discover |
| `prompts/list` & `prompts/get` | Ignored / N/A | Supported | Supported (`architecture_review`, etc.) | Needs unified discover |
| `notifications/cancelled` | N/A | Supported | Supported (Capped queue, `AtomicBool`) | Supported |
| `ping` | Supported | Supported | Supported | Supported |
| **Status in PTT** | **Supported** | **Supported** | **Supported (Current Default/Latest)** | **Explicitly Rejected in Negotiation** |

---

## 4. Evaluation: Custom Implementation vs Official `rmcp` Rust SDK

We conducted a technical comparison between our existing custom stdio implementation and the official Rust SDK (`modelcontextprotocol/rust-sdk`, currently `rmcp` crate series):

| Criterion | ProjectToText Custom Server (`src/mcp.rs`) | Official `rmcp` Rust SDK | Assessment |
|---|---|---|---|
| **Async Runtime & Dependencies** | **Zero async runtime.** Synchronous stdio reader + thread-safe dispatch using `rayon` thread pool and bounded channels. | Requires `tokio` (full), `tower`, `axum` (for SSE/HTTP), `tracing`, and async macros. | `rmcp` would increase dependency tree by >80 crates and binary size by ~2.5–4.0 MB. |
| **MSRV Alignment** | Compatible with PTT MSRV (`rust-version = "1.90"`). Verified in CI. | Targets latest stable Rust (typically requiring rustc >= 1.94+). | Risk of breaking strict MSRV bounds. |
| **Security & Path Confinement** | Direct hook into `open_verified_regular_file` (`O_NOFOLLOW`, descriptor dev/ino match, root containment). | Generic router. Custom security layer must still wrap every handler. | Equal or slightly worse (extra abstraction layer). |
| **Buffer Exhaustion Defense** | Explicit 4 MiB stdin line limit with drain loop; explicit 8 MiB response cap; 1024 pending cancellation cap. | Standard JSON-RPC framing; buffer bounds depend on underlying transport reader configuration. | Custom server is tightly tailored to avoid DoS. |
| **Worker Pooling & Cancellation** | 16 worker slots with timeout (30s) and lock-free `Arc<AtomicBool>` cooperative cancellation. | Tokio task cancellation via `JoinHandle::abort` or `CancellationToken`. | Comparable, but custom server works cleanly with Rayon. |
| **Protocol Evolution** | Must manually implement new revisions and test them. | Upgrades managed by official maintainers. | Advantage `rmcp` for future updates once API stabilizes. |

---

## 5. Architectural Decision

1. **Retain Custom Server for Production (Status Quo):**
   ProjectToText will maintain its high-performance, zero-async, secure stdio implementation for protocol revisions `2024-11-05`, `2025-06-18`, and `2025-11-25`.
2. **Do Not Advertise `2026-07-28` Until Fully Implemented:**
   The server will continue to respond with `2025-11-25` when `2026-07-28` or unknown revisions are requested in `initialize`. This preserves complete stability and compatibility with today's IDEs and agent clients.
3. **Migration & Conformance Roadmap for `2026-07-28`:**
   - Develop an isolated protocol adapter module (`src/mcp/v2026_07_28.rs`) implementing `server/discover` and `_meta` request parsing.
   - Run the official [MCP Conformance Test Suite](https://github.com/modelcontextprotocol/conformance) against this adapter before enabling it in release builds.
   - Periodically re-evaluate `rmcp` as it matures, specifically monitoring its dependency footprint and whether a minimal stdio-only headless feature flag is provided by the SDK authors.

---

## 6. Verification and Automated Evidence

1. `tests/mcp_stdio_client.rs`: drives the compiled binary over stdio with full protocol negotiation (`2025-11-25`), tool execution, resource reading, and prompt generation, verifying pure JSON stdout and clean stderr.
2. `src/mcp/tests.rs`:
   - `mcp_negotiates_protocol_versions_and_validates_schemas_and_cancellation`: verifies that `2024-11-05`, `2025-06-18`, and `2025-11-25` are echoed verbatim, and that `2026-07-28` falls back safely to `2025-11-25`.
   - `mcp_sandbox_rejects_paths_outside_root`: verifies directory traversal prevention.
   - `mcp_cancellation_and_worker_pool`: verifies bounded cancellation table and cooperative worker abort.
3. `src/mcp/fuzz_tests.rs`: 4,000 randomized malformed JSON-RPC payloads and hostile paths must never panic or violate protocol.
