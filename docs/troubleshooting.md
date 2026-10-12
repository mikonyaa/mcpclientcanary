# Troubleshooting

**Doctor returns 2.** Check the explicit executable path, platform manifest hash and native --version. Missing files, malformed manifests and hashes that disagree with expected bytes are errors. Never replace a binary simply to get a prettier column.

**Doctor returns 3 / unknown version.** Only the two documented macOS arm64 pins are verified. --allow-unverified is a diagnostic override and cannot turn the verdict into pass. Version labels alone are not provenance.

**No deferred coverage.** The child sets ENABLE_TOOL_SEARCH=true because a custom ANTHROPIC_BASE_URL normally disables deferred loading. The inherited CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is removed; disabling experimental features wholesale changes the measured target behavior. A ToolSearch inventory entry alone is not execution. Inspect initial-deferred and the matched result ID.

**Custom endpoint error.** The driver accepts only 127.0.0.1, uses an ephemeral port and a synthetic credential, and implements Messages JSON/SSE. No external proxy or provider fallback is used. A rejected or drifting protocol gives error/incomplete, not a client stale verdict. No real account login is a workaround.

**Resume unproved.** Compare both native session IDs and priorNoncePresent. Merely passing --resume is insufficient. A fresh session, --fork-session or a nonce reintroduced by the harness cannot pass. Keep the owned config and project until the case finishes; the tool removes them afterward.

**Both columns fail.** This is a valid measured result. Check that the harness is complete and that notification-wire shows a real B response, while current input resolves to A. Successful tools/call with new arguments would not repair the current definition proof.

**No tools/list after the notification.** Send does not prove receipt and MCP does not promise an immediate re-list. The declared bounded contract can report a measured absence only with all mandatory instrumentation and a stale unique current definition. A recorder error or unobserved trigger remains incomplete.

**Managed policy blocks a run.** The harness does not edit managed policy or bypass it. Record unsupported coverage and resolve the policy through the normal administrator process.

**Report copy button falls back.** Under file:// the Clipboard API can be unavailable. The command appears in a focused selectable textarea. Use the normal keyboard copy shortcut.

**Interrupted run.** Only spawned native processes and owned endpoints are stopped. Output includes a bounded diagnostic report and exit 130. Existing profiles, processes and ports are not modified. Supply a new --out directory for the next run.
