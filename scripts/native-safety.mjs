import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createOwned, cleanupOwned } from '../dist/native/isolation.js';
import { verifyClient } from '../dist/adapters/claude-code/index.js';
import { NativeDriver } from '../dist/native/driver.js';
import { runCase } from '../dist/scenarios/state-machine.js';
const argv = process.argv.slice(2),
  path = argv[argv.indexOf('--clients') + 1];
if (!argv.includes('--clients'))
  throw Error('Pass --clients; native safety checks cannot be skipped');
const clients = JSON.parse(await readFile(path, 'utf8')).clients;
const parent = await mkdtemp(join(tmpdir(), 'canary-native-safety-'));
const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
const results = [];
try {
  // Explicitly selected concurrency of two; each owns independent native/config/model resources.
  const parallel = await Promise.all(clients.map((c) => runCase(c, 'same-name', 1, parent, 30000)));
  assert(parallel.every((c) => c.exitCode === 1 && c.harnessStatus === 'complete'));
  assert.notEqual(parallel[0].id, parallel[1].id);
  assert.notEqual(parallel[0].continuity.initialSessionId, parallel[1].continuity.initialSessionId);
  const refs = parallel.map((c) => new Set(c.evidence.map((e) => e.ref)));
  assert([...refs[0]].every((r) => !refs[1].has(r)));
  results.push('two concurrent native cases are independent');
  for (const kind of ['timeout', 'interrupt', 'truncated-sse']) {
    const owned = await createOwned(parent);
    const check = await verifyClient(clients[0], owned);
    const abort = new AbortController();
    let observed = false;
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk;
      }
      observed = true;
      if (kind === 'interrupt') abort.abort();
      if (kind === 'truncated-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_start\ndata: {"type":\n\n');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const model = {
      url: 'http://127.0.0.1:' + server.address().port,
      phase: 'A',
      generation: 1,
      stage: 'initial',
      ids: new Set(),
      error: undefined,
    };
    const driver = new NativeDriver(check.executable, owned, model, 2000, abort.signal);
    const mcp = resolve(owned.root, 'mcp.json');
    await writeFile(mcp, '{"mcpServers":{}}');
    try {
      driver.start(mcp);
      await assert.rejects(
        () => driver.turn('Own synthetic safety test'),
        (e) => (kind === 'interrupt' ? e.code === 130 : [2, 3].includes(e.code)),
      );
      assert(observed, 'Actual native request must reach the controlled endpoint');
      await driver.close(false);
      assert.equal(driver.child, undefined);
      assert.equal(sentinel.exitCode, null);
      results.push(kind + ' cannot become a measured pass and owned native is closed');
    } finally {
      await driver.close(false);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await cleanupOwned(owned);
    }
  }
  await mkdirSafe();
  console.log(
    JSON.stringify({ nativeSafety: 'passed', checks: results, foreignSentinelUntouched: true }),
  );
  async function mkdirSafe() {
    const { mkdir } = await import('node:fs/promises');
    await mkdir('test-results', { recursive: true });
    await writeFile(
      'test-results/native-safety.json',
      JSON.stringify(
        { nativeSafety: 'passed', checks: results, foreignSentinelUntouched: true },
        null,
        2,
      ),
    );
  }
} finally {
  sentinel.kill('SIGTERM');
  await rm(parent, { recursive: true, force: true });
}
