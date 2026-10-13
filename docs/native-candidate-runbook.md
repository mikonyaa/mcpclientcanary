# Pinned native candidate verification

Use a real macOS arm64 host with Node >=22.16 <27. The report-layer changes do not widen supported clients, measure model quality or certify MCP conformance. Portable tests and recorded rendering are separate gates.

## Clean package consumer

Use a fresh folder outside the source checkout, including Unicode/spaces. Keep clients.local.json, native executables and local doctor/config/session data private. Synthetic loopback needs no account login.

```sh
mkdir 'canary consumer Юникод'
cd 'canary consumer Юникод'
npm init -y
npm install --omit=dev --ignore-scripts --no-audit --no-fund /absolute/path/mcpclientcanary-0.1.1.tgz
./node_modules/.bin/mcpclientcanary --version
./node_modules/.bin/mcpclientcanary init --dir './example Юникод with spaces'
node node_modules/mcpclientcanary/examples/acquire-clients.mjs --cache ./native-cache --manifest ./clients.local.json
/usr/bin/codesign --verify --strict --verbose=2 ./native-cache/2.1.294/claude
/usr/bin/codesign --verify --strict --verbose=2 ./native-cache/2.1.296/claude
/usr/bin/codesign -dv --verbose=4 ./native-cache/2.1.294/claude
/usr/bin/codesign -dv --verbose=4 ./native-cache/2.1.296/claude
./node_modules/.bin/mcpclientcanary doctor --clients ./clients.local.json --out ./doctor-local --json
```

The explicit helper downloads only official manifests/binaries, checks exact hashes, refuses occupied version caches and never invokes install/update/login/logout. The baseline adapter checks hash/version/help/clean auth but does not invoke codesign: signature verification is an additional explicit gate above. Stop on signature/hash mismatch, unknown identity, unexpected auth/config directory or doctor exit other than 0. Do not use diagnostic `--allow-unverified` for release coverage or reuse user credentials.

| Version | Official darwin-arm64 SHA-256 | Manifest |
| --- | --- | --- |
| 2.1.294 | `def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53` | [Official manifest](https://downloads.claude.ai/claude-code-releases/2.1.294/manifest.json) |
| 2.1.296 | `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` | [Official manifest](https://downloads.claude.ai/claude-code-releases/2.1.296/manifest.json) |

Both manifests were checked against these pins on 2026-10-14. Runs use separate project/config/credential namespaces, environment allowlists and owned bounded processes. `networkSandbox: false` remains explicit; configuration isolation is not an OS network air gap.

## Actual 24-case run and safety

```sh
./node_modules/.bin/mcpclientcanary run --clients ./clients.local.json --suite core --repeat 2 --timeout 30 --out ./native-core --json
./node_modules/.bin/mcpclientcanary report ./native-core/report.json --out ./reopened-native.html --json
python3 -c 'import xml.etree.ElementTree as E; E.parse("native-core/junit.xml")'
```

Record actual exit. Exit 1 means a complete harness with measured client contract violations; historical pins yielded 12 failed cases. It is not automatically a harness failure. Exit 2/3/130 means error/incomplete/cancellation. Inspect stages and diagnostics instead of relabeling results.

Require six scenarios × two versions × two independent repeats, distinct case IDs, native session continuity, prior nonce in resumed history, no nonce/schema reintroduction, same-request ToolReference resolution, three recorder checkpoints, bounded observation window/next turn and successful process closures. Preserve historical A/current B distinction and notification send versus receipt.

From the candidate source checkout, use the actual installed CLI for native acceptance:

```sh
npm run test:native -- --clients /absolute/path/clients.local.json --cli '/absolute/path/canary consumer Юникод/node_modules/mcpclientcanary/dist/cli/main.js' --out /absolute/path/fresh-native-acceptance
npm run test:native-safety -- --clients /absolute/path/clients.local.json
```

The native script expects historical actual CLI exit 1 and 24 cases and never silently skips missing clients. Safety runs two explicitly owned concurrent cases, preserves an unrelated owned process sentinel, kills only its own fixture, and checks timeout/interruption/truncated SSE and cleanup. Safety uses source modules; installed-package behavior is a distinct gate. Export safe projected evidence, not private configs/local manifests.

## Repeat and remaining external condition

Install the same tgz in another fresh consumer and run a new 24-case suite. Compare outcomes while requiring disjoint case/session IDs, recorder instances and refs. This is a same-host local repeat.

External reproducibility still requires an independent operator/host with independently obtained evidence. A second process, folder or reviewer on one host does not meet that condition. Server-author pilot and broader client/version support are outside current confirmation. Preserve historical reports unchanged and never synthesize native proof from SDK mocks.
