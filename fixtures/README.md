# Original synthetic fixtures

Each JSON file describes one built-in preset and its separate description/inputSchema hashes. They contain only harmless synthetic definitions. The CLI accepts the six named presets; it does not eval or execute JSON and does not accept arbitrary user MCP configs. These files are standalone inspection fixtures, not an undocumented scenario override API.

The compiled fixture entry is included in the npm package at dist/server/fixture-server.js. The native CLI launches that entry with its own run root, atomic control file and evidence path. For manual server inspection, create a fresh owned directory containing .canary-owner and a schema-valid control.json with a matching runId, then invoke the compiled entry with those three paths. Keep stdout reserved for JSON-RPC. The native report is a separate measurement; an SDK or Inspector check proves only server behavior.
