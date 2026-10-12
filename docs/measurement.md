# Observation contract, schemaVersion 1

Target: native Claude Code 2.1.294 and 2.1.296 on macOS arm64; no SDK wrapper replaces the CLI. The original motivating [issue #97369](https://github.com/anthropics/claude-code/issues/97369) was checked open on 2026-10-13 (Asia/Almaty). Its examples and version claims are external context, not the result of this experiment.

Protocol is **2025-11-25 stateful stdio**, supported by the pinned SDK 1.32.1 and both actual clients. These clients first probe 2026-07-28 server/discover; the SDK returns Method not found and the native CLI then performs initialize with 2025-11-25. That normal fallback is retained in evidence. This fixture does not claim to implement the later stateless revision.

Each case starts the real executable from its own verified path. The report includes native version, official distribution digest, executable basename/path digest, actual PIDs, OS/arch, redacted argv and structured session IDs. Personal realpaths are in the local doctor manifest only.

The driver gets the actual ToolSearch name and input schema from the outbound request, and the synthetic target name from its observed inventory. It emits only tool_use, not tool_result or a supplied schema. The native CLI executes ToolSearch. On the next outbound request the observer matches the returned tool_use_id and reads native tool_reference blocks. [Anthropic's documented reference mechanism](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) expands references against the definitions in the same tools array. A unique matching entry permits a pre-inference resolution; a missing or conflicting entry is unknown/ambiguous.

The report's loaded layer is explicitly a reference plus resolution, not a claim that the result contained an inline JSON schema. The current definition and historical definitions are separate. Historical A alongside current B is legal and does not produce a stale verdict. No inference takes place and no claim about a model's understanding is made.

Lifecycle order:

1. Initial CLI native request → ToolSearch → real native tool_result → outbound current A (or fresh B).
2. Successful native turn + own recorder checkpoint.
3. Atomically replace own control A1→B2. The same live server records phase-applied before notification send.
4. Wait a predeclared 1,000 ms following notification-complete. Capture tools/list request/response pairs if the client re-lists.
5. Send a neutral next user turn containing no expected B schema. Repeat genuine ToolSearch, capture and native completion checkpoint.
6. Close stdin, observe native exit 0, then launch the same executable with --resume the native session ID.
7. Newly launched fixture reads saved B. Repeat ToolSearch/capture. Require the same native session ID and earlier nonce in outbound messages; the resume prompt carries neither nonce nor schema.
8. Get final own recorder checkpoint, close native stream and endpoint, check sequences/digests and remove own config/session directories.

The own checkpoint protocol is instrumentation on the fixture control channel; it does not edit a client transcript, force a client re-list or issue an MCP request. It confirms synchronous recorder coverage through each observation window. Native process shutdown can terminate the stdio child without an EOF; an explicit checkpoint is required before shutdown instead of inventing a stream-end event.

Streams have monotonic per-producer sequence numbers and integrity digests. Causality uses request/tool IDs, server instance/generation and explicit checkpoint/transition references, not a merged wall-clock sort. SHA-256 here is integrity metadata, not a cryptographic attestation or signature.

A sent notification is not an acknowledgement. A missing re-list is an observed client lifecycle failure only when trigger, bounded window, completed turns, initial deferred load, capture, continuity and recorder checkpoints all exist and the unique effective definition is stale. Otherwise the run is incomplete. MCP specification conformity and this declared lifecycle contract are distinct.

Public data contains only our definitions, safe reference blocks and minimal provenance. Native system prompts and raw model traffic are not persisted. The 16 MiB case model budget includes all received request bytes even though only projections are saved. No fallback model request exists. Config isolation is not a full network sandbox.
