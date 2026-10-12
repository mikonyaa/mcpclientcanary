import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Recorder,
  digest,
  canonical,
  validateEvents,
  readEvents,
} from '../../dist/evidence/collector.js';
import { resolveDefinition } from '../../dist/evidence/resolve.js';
import { definitions, validateArguments } from '../../dist/server/definitions.js';
import { childEnvironment, createOwned, cleanupOwned } from '../../dist/native/isolation.js';
import { within, writeControl, readControl } from '../../dist/server/phase-control.js';
import { continuity } from '../../dist/scenarios/state-machine.js';
import { verdict, stage, aggregateExit } from '../../dist/verdict/contracts.js';
import {
  searchInvocation,
  requestProjection,
  messagesResponse,
} from '../../dist/model/protocol.js';
import { htmlReport, escapeHtml } from '../../dist/report/html.js';
import { Loopback } from '../../dist/model/loopback.js';
import { junitReport } from '../../dist/report/index.js';
import { clientsSchema, controlSchema, CanaryError } from '../../dist/types.js';
const A = definitions({ scenario: 'same-name', phase: 'A' })[0],
  B = definitions({ scenario: 'same-name', phase: 'B' })[0];
const api = (d) => ({ ...d, name: 'mcp__canary__lookup_record', defer_loading: true });
function observed(
  current,
  refs = [{ type: 'tool_reference', tool_name: 'mcp__canary__lookup_record' }],
  historical = [],
) {
  const r = new Recorder('model');
  for (const d of historical) r.add('request', { stage: 'initial', tools: [api(d)], results: [] });
  const capture = r.add('request', { stage: 'resume', tools: current.map(api), results: [] });
  r.add('search-result-observed', {
    stage: 'resume',
    toolUseId: 'toolu_own',
    captureRef: capture.ref,
    isError: false,
    references: refs,
    inlineDefinitions: [],
  });
  return r.events;
}
test('A and B keep the name and separately change both hashes', () => {
  assert.equal(A.name, B.name);
  assert.notEqual(digest(A.description), digest(B.description));
  assert.notEqual(digest(A.inputSchema), digest(B.inputSchema));
});
test('schema-only changes do not change description', () => {
  const d = definitions({ scenario: 'schema-only', phase: 'B' })[0];
  assert.equal(d.description, A.description);
  assert.deepEqual(d.inputSchema, B.inputSchema);
});
test('description-only changes do not change input schema', () => {
  const d = definitions({ scenario: 'description-only', phase: 'B' })[0];
  assert.equal(d.description, B.description);
  assert.deepEqual(d.inputSchema, A.inputSchema);
});
test('added tool leaves same-name definition A', () => {
  const list = definitions({ scenario: 'added-tool', phase: 'B' });
  assert.deepEqual(list[0], A);
  assert.equal(list[1].name, 'lookup_summary');
});
test('strict arguments require detail only in B', () => {
  assert(validateArguments(A, { recordId: 'own' }).success);
  assert(!validateArguments(B, { recordId: 'own' }).success);
  assert(validateArguments(B, { recordId: 'own', detail: 'summary' }).success);
  assert(!validateArguments(B, { recordId: 'own', detail: 'invalid' }).success);
  assert(!validateArguments(A, { recordId: 'own', shell: 'unsafe' }).success);
});
test('current B with historical A is current, not stale', () => {
  const r = resolveDefinition(
    observed([B], undefined, [A]),
    'resume',
    'mcp__canary__lookup_record',
    B,
  );
  assert.equal(r.status, 'resolved');
  assert.equal(r.descriptionStatus, 'current');
  assert.equal(r.schemaStatus, 'current');
  assert.equal(r.historical.length, 1);
});
test('stale current A is a measured separate description/schema mismatch', () => {
  const r = resolveDefinition(observed([A]), 'resume', 'mcp__canary__lookup_record', B);
  assert.equal(r.descriptionStatus, 'stale');
  assert.equal(r.schemaStatus, 'stale');
});
test('description-only stale is distinct from schema stale', () => {
  const r = resolveDefinition(
    observed([A]),
    'resume',
    'mcp__canary__lookup_record',
    definitions({ scenario: 'description-only', phase: 'B' })[0],
  );
  assert.equal(r.descriptionStatus, 'stale');
  assert.equal(r.schemaStatus, 'current');
});
test('schema-only stale is distinct from description stale', () => {
  const r = resolveDefinition(
    observed([A]),
    'resume',
    'mcp__canary__lookup_record',
    definitions({ scenario: 'schema-only', phase: 'B' })[0],
  );
  assert.equal(r.descriptionStatus, 'current');
  assert.equal(r.schemaStatus, 'stale');
});
test('unresolved tool reference returns unknown', () =>
  assert.equal(
    resolveDefinition(observed([]), 'resume', 'mcp__canary__lookup_record', B).status,
    'unknown',
  ));
test('two current definitions cannot choose a convenient hash', () =>
  assert.equal(
    resolveDefinition(observed([A, B]), 'resume', 'mcp__canary__lookup_record', B).status,
    'ambiguous',
  ));
test('two references cannot claim effective resolution', () =>
  assert.equal(
    resolveDefinition(
      observed(
        [B],
        [{ tool_name: 'mcp__canary__lookup_record' }, { tool_name: 'mcp__canary__lookup_record' }],
      ),
      'resume',
      'mcp__canary__lookup_record',
      B,
    ).status,
    'ambiguous',
  ));
test('missing actual ToolSearch result is unknown', () =>
  assert.equal(
    resolveDefinition(observed([B]).slice(0, 1), 'resume', 'mcp__canary__lookup_record', B).status,
    'unknown',
  ));
test('evidence sequence, duplicate and digest mutation are rejected', () => {
  const r = new Recorder('model');
  r.add('one', { a: 1 });
  r.add('two', { a: 2 });
  validateEvents(r.events);
  assert.throws(() => validateEvents(r.events.slice(1)));
  const changed = structuredClone(r.events);
  changed[1].data.a = 3;
  assert.throws(() => validateEvents(changed));
  assert.throws(() => validateEvents([...r.events, r.events[1]]));
});
test('canonical hashes sort object keys and preserve invisible Unicode', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.notEqual(digest('text'), digest('text\u200b'));
});
test('truncated records do not become a valid empty stream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canary-record-'));
  try {
    const file = join(dir, 'events');
    await writeFile(file, '{"broken":true}');
    assert.throws(() => readEvents(file));
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('native continuity requires original ID and an unreintroduced nonce', () => {
  assert(continuity('same', 'same', true));
  assert(!continuity('first', 'fresh', true));
  assert(!continuity('same', 'same', false));
  assert(!continuity('same', 'same', true, true));
  assert(!continuity(undefined, undefined, true));
});
test('missing stages outrank observed failures', () => {
  assert.equal(
    verdict([stage('a', 'observed-fail', 'stale'), stage('resume', 'not-reached', 'missing')], [])
      .exitCode,
    3,
  );
  assert.equal(verdict([stage('a', 'observed-pass', 'yes')], [], false).exitCode, 3);
  assert.equal(verdict([], []).exitCode, 3);
});
test('loaded result from another capture cannot establish the current schema', () => {
  const events = observed([B]);
  events[1].data.captureRef = 'unrelated-capture';
  assert.equal(
    resolveDefinition(events, 'resume', 'mcp__canary__lookup_record', B).status,
    'unknown',
  );
});
test('later captures cannot appear as historical definitions of an earlier stage', () => {
  const events = observed([B], undefined, [A]);
  const initial = resolveDefinition(events, 'initial', 'mcp__canary__lookup_record', A);
  assert.deepEqual(initial.historical, []);
});
test('harness error outranks missing coverage and client failure', () => {
  assert.equal(verdict([stage('a', 'not-reached', 'missing')], ['I/O']).exitCode, 2);
  assert.equal(aggregateExit([0, 1, 3, 2]), 2);
  assert.equal(aggregateExit([]), 3);
  assert.equal(aggregateExit([0, 1]), 1);
  assert.equal(aggregateExit([130, 2]), 130);
});
test('a complete detector can correctly fail the client contract', () => {
  assert.deepEqual(verdict([stage('a', 'observed-fail', 'stale')], []), {
    harnessStatus: 'complete',
    clientContractStatus: 'observed-fail',
    exitCode: 1,
  });
});
test('environment allowlist strips accounts, proxies, preloads and experimental overrides', () => {
  const env = childEnvironment('/owned', 'http://127.0.0.1:1234', {
    HOME: '/same',
    CODEX_HOME: '/untouched',
    ANTHROPIC_API_KEY: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    HTTPS_PROXY: 'secret',
    NODE_OPTIONS: 'bad',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    ENABLE_TOOL_SEARCH: 'false',
  });
  assert.equal(env.HOME, '/same');
  assert.equal(env.ENABLE_TOOL_SEARCH, 'true');
  for (const key of [
    'CODEX_HOME',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'HTTPS_PROXY',
    'NODE_OPTIONS',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  ])
    assert.equal(env[key], undefined);
  assert.match(env.ANTHROPIC_AUTH_TOKEN, /synthetic-loopback/);
});
test('external endpoints and URL credential injection are rejected', () => {
  for (const url of [
    'https://api.anthropic.com',
    'http://localhost:80',
    'http://user:pass@127.0.0.1:80',
  ])
    assert.throws(() => childEnvironment('/owned', url), CanaryError);
});
test('two owned runs have independent paths and cleanup checks markers', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'canary-owned-'));
  try {
    const a = await createOwned(parent),
      b = await createOwned(parent);
    assert.notEqual(a.config, b.config);
    await writeFile(join(a.root, '.canary-owner'), 'foreign');
    await assert.rejects(() => cleanupOwned(a));
    await cleanupOwned(b);
  } finally {
    await rm(parent, { recursive: true });
  }
});
test('control paths reject traversal and symlink escapes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'canary-path-'));
  try {
    const a = await createOwned(parent);
    await assert.rejects(() => within(a.root, join(a.root, '../foreign')));
    await symlink('/tmp', join(a.root, 'escape'));
    await assert.rejects(() => within(a.root, join(a.root, 'escape/file')));
  } finally {
    await rm(parent, { recursive: true });
  }
});
test('atomic own control updates preserve B and reject untrusted keys', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'canary-control-'));
  try {
    const a = await createOwned(parent);
    const c = {
      schemaVersion: 1,
      runId: a.runId,
      scenario: 'same-name',
      phase: 'B',
      generation: 2,
    };
    await writeControl(a.root, a.control, c);
    assert.deepEqual(await readControl(a.root, a.control), c);
    assert(!controlSchema.safeParse({ ...c, exec: 'evil' }).success);
  } finally {
    await rm(parent, { recursive: true });
  }
});
test('missing ToolSearch and native input drift are unsupported', () => {
  assert.throws(
    () => searchInvocation({ tools: [] }, 'lookup_record'),
    (e) => e.code === 3,
  );
  assert.throws(
    () =>
      searchInvocation(
        {
          tools: [{ name: 'ToolSearch', input_schema: { properties: {} } }],
          inventory: 'mcp__canary__lookup_record',
        },
        'lookup_record',
      ),
    (e) => e.code === 3,
  );
});
test('projection strips proprietary system prompts, headers and unrelated results', () => {
  const p = requestProjection(
    {
      system: 'PROPRIETARY',
      headers: { authorization: 'SECRET' },
      tools: [
        { name: 'Bash', description: 'PRIVATE' },
        {
          name: 'mcp__canary__lookup_record',
          description: A.description,
          input_schema: A.inputSchema,
          defer_loading: true,
        },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'foreign', content: 'PRIVATE' }],
        },
      ],
    },
    new Set(),
    'NONCE',
  );
  assert(!JSON.stringify(p).includes('PRIVATE'));
  assert(!JSON.stringify(p).includes('PROPRIETARY'));
  assert(!JSON.stringify(p).includes('SECRET'));
});
test('SSE response includes complete native message and content boundaries', () => {
  let text = '';
  const res = {
    writeHead() {},
    write(s) {
      text += s;
    },
    end() {},
  };
  messagesResponse(
    res,
    { stream: true, model: 'synthetic' },
    [{ type: 'tool_use', id: 'own', name: 'ToolSearch', input: { query: 'own' } }],
    1,
  );
  for (const name of [
    'message_start',
    'content_block_start',
    'input_json_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
    assert(text.includes(name));
  assert(text.endsWith('\n\n'));
});
test('clients schema requires a verified hash and rejects unrelated config', () => {
  assert(!clientsSchema.safeParse({ schemaVersion: 1, clients: [], arbitraryMcp: {} }).success);
});
test('HTML escaping contains tags and ANSI without executing them', () => {
  const hostile = '</script><img src=x onerror=alert(1)>\u001b[31m';
  const escaped = escapeHtml(hostile);
  assert(!escaped.includes('<'));
  assert(!escaped.includes('\u001b'));
});
test('malformed Messages JSON remains an explicit harness protocol error', async () => {
  const model = new Loopback('own-nonce');
  await model.start();
  try {
    const response = await fetch(model.url + '/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer mcpclientcanary-synthetic-loopback-only' },
      body: '{malformed',
    });
    assert.equal(response.status, 400);
    assert.equal(model.error.code, 2);
    assert(model.recorder.events.some((e) => e.event === 'model-error'));
  } finally {
    await model.close();
  }
});
test('recorder append rejects a symlink created at the evidence file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canary-symlink-record-'));
  try {
    const foreign = join(dir, 'foreign');
    await writeFile(foreign, 'untouched');
    const file = join(dir, 'events');
    await symlink(foreign, file);
    assert.throws(() => new Recorder('server', file).add('own', {}));
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(foreign, 'utf8'), 'untouched');
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('empty report is explicit incomplete and script data cannot close the script', () => {
  const r = {
    schemaVersion: 1,
    runId: randomUUID(),
    timestamp: '2026-10-13',
    toolVersion: '0.1.0',
    sourceCommit: '</script><script>globalThis.pwned=1</script>',
    environment: { os: 'darwin', arch: 'arm64' },
    clients: [],
    negotiatedProtocol: '2025-11-25',
    adapterVersion: '1',
    captureMode: 'loopback-synthetic-pre-inference',
    recorded: true,
    exitCode: 3,
    cases: [],
    omissions: [],
    reproduceCommands: ['</script>'],
  };
  const html = htmlReport(r);
  assert(html.includes('Incomplete native coverage'));
  assert(!html.includes('<script>globalThis.pwned'));
  assert(html.includes('\\u003c/script>'));
  assert(junitReport(r).includes('tests="0"'));
});
