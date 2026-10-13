# Changelog

## 0.1.1 (local release candidate)

Reports now enforce semantic coherence and recompute definitions/stage outcomes from evidence. Invalid imports return 2 before HTML publication. Complete bundles publish atomically to a fresh directory with preserved separate diagnostics. XML 1.0 encoding handles forbidden values visibly while JSON stays unchanged. Offline HTML adds hashed CSP and local JSON export. Schema remains v1 with documented stricter acceptance and JSON Lines stderr under `--json`.

Portable tests, package consumers and pinned native gates are recorded separately in the candidate's local verification artifacts. No release/site/registry publication is implied.

## 0.1.0

Initial experimental native regression harness for Claude Code 2.1.294 / 2.1.296 on macOS arm64. Adds isolated ToolSearch → live same-name mutation → true resume, six repeated controls, safe evidence resolution and JSON/HTML/JUnit reports. Both pinned clients exhibit stale same-name definitions in the measured synthetic mode. Native verification is local; portable CI is separately labeled. Reconnect and npm registry publication are not included.
