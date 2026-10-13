# Report integrity and export compatibility (0.1.1)

Reports retain `schemaVersion: 1`, existing field names and original evidence. Version 0.1.1 adds semantic acceptance beyond the shape schema. `loadReport`, HTML, JUnit and bundle export share the pure `validateReport` boundary. Shape-valid but inconsistent reports return exit 2. No evidence or verdict is silently repaired.

Checks cover unique case selections/IDs, stages and event refs; producer/instance sequences and canonical data digests; causal request, ToolSearch, native result and checkpoint links; required resolution/stage sets; fixture hashes; definition summaries recomputed from outbound observations; native resume session/nonce continuity; bounded windows and next-turn order; isolation provenance; and existing verdict aggregates. Human display reasons and reproduce commands remain author-supplied text and do not determine measurement status.

Measured cases have 16 stages; early verification failures have the other 15 and no isolation stage. Partial captures retain all required stages, unavailable observations marked `not-reached`/`not-supported`, all three resolution slots and explicit null/false continuity. Errors, unsupported observations and cancellation retain exit 2/3/130. An interrupted suite between cases may set `environment.cancelled: true`; its coverage cannot display complete even if collected cases pass. An older suite with exit 130 but neither a cancelled case nor this marker requires export/recollection by the original producer; the importer does not invent the marker.

**Semantic integrity is not authenticity.** Coherence and SHA-256 detect inconsistent edits. They are not signatures, execution attestation or protection against an author fabricating an entirely consistent stream and recomputing digests. Timing is recorder-relative. Selected lifecycle findings are not MCP conformance; `listChanged` SHOULD is not made MUST.

The packaged `examples/recorded-report.json` is unchanged historical author evidence: 24 cases, 1,488 events, 12 measured failures. `demo --recorded` labels it recorded and returns `currentRuntimeTested: false`. Rendering/reopening never proves current native behavior. These export commands return 0 for valid reports including observed-fail evidence. Native `run` retains measurement exit semantics.

## Transactions and diagnostics

Use a **nonexistent** `--out` directory. Existing files, symlinks and even empty directories produce an actionable conflict error. This tightens the previous fresh-output convention: do not create the final directory first.

All three files are staged and flushed at mode 0600 in an owned sibling directory. The writer exclusively reserves the fresh output directory, then renames the complete staged directory on the same filesystem. JSON/HTML/JUnit appear together. Failures and handled cancellation roll back only tracked own inodes. Foreign replacements/contents survive; recursive deletion is not used. Concurrent writers cannot both claim a reservation. A temporary empty reservation can be visible before publication.

Native diagnostics use a separate private sibling `.OUTPUT-diagnostics-…` directory. `capture-report.diagnostic.json` is saved before validation/publication. It can contain rejected or incomplete data and is never presented as a successfully published bundle. Success JSON includes `diagnostics`; export errors identify preserved evidence. Owner/control files are local diagnostic material, not release assets.

Cancellation after the commit atomically withdraws the whole owned directory before file cleanup. If unlink cleanup then fails, only private staging can be partial. If the withdrawal rename itself fails, the complete bundle is retained and the error explicitly identifies that state; ready files are never deleted individually. A late notification collected after the trigger deadline remains diagnostic evidence and does not promote an incomplete trigger to measured pass.

HTML-only export commits its completed staged file with an exclusive hard link and never truncates an existing path. Under `--json`, stderr is JSON Lines progress/error records and stdout is one success object, or empty on error. SIGINT during capture exports an explicit cancelled report; SIGINT during publication rolls back and returns 130.

Atomic visibility differs from power-loss durability. Files are flushed, but no durable multi-directory journal is claimed. SIGKILL/power loss can leave owned staging or an empty reservation; it does not create mixed old/new report files. Deliberate hostile path replacement by another process using the same OS account is outside this isolation boundary. Use a private owned parent directory.

## XML and offline HTML

JUnit follows the [XML 1.0 Fifth Edition Char production](https://www.w3.org/TR/xml/#charsets). U+FFFE/U+FFFF, forbidden controls and unpaired surrogate code units become visible `[U+XXXX]` text. Valid astral scalars remain intact. Numeric whitespace references preserve attributes through XML normalization. JSON retains original allowed strings. Tests parse attributes and failure text independently with Python ElementTree.

Offline HTML preserves the visual style and adds exact script/style hashes in CSP, `default-src 'none'` and `connect-src 'none'`. JSON export downloads the validated embedded report using a local Blob. No remote fonts, CDN, analytics or network export is added.

## Migration

1. Preserve original evidence and older outputs.
2. Reopen consistent v1 with `mcpclientcanary report old/report.json --out new.html --json`.
3. If rejected, inspect the scoped error and original producer artifact. Recollect missing evidence instead of editing hashes/verdicts to pass.
4. Choose a fresh bundle directory; diagnostics now live separately.
5. Consumers parsing plain stderr under `--json` must accept JSON Lines. Ordinary non-JSON terminal output remains text.
