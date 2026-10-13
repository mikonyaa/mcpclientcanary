import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { reportSchema, CORE } from '../dist/types.js';
import { validateEvents } from '../dist/evidence/collector.js';
import { definitions } from '../dist/server/definitions.js';
import { resolveDefinition } from '../dist/evidence/resolve.js';
const options = process.argv.slice(2);
const clients = options[options.indexOf('--clients') + 1];
if (!options.includes('--clients') || !clients)
  throw Error('Pass --clients <local manifest>; native tests are never silently skipped');
const cliIndex = options.indexOf('--cli'),
  cli = cliIndex >= 0 ? resolve(options[cliIndex + 1]) : resolve('dist/cli/main.js');
const outIndex = options.indexOf('--out'),
  out =
    outIndex >= 0 ? resolve(options[outIndex + 1]) : resolve('test-results/native-' + randomUUID());
await mkdir(dirname(out), { recursive: true });
// Controlled canaries are installed in this test process only, after Node starts.
// Any inheritance into the native CLI would break auth or fixture startup.
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'CANARY_PARENT_KEY_MUST_NOT_PASS',
  CLAUDE_CODE_OAUTH_TOKEN: 'CANARY_PARENT_OAUTH_MUST_NOT_PASS',
  NODE_OPTIONS: '--require=/CANARY_PARENT_PRELOAD_MUST_NOT_PASS',
  HTTPS_PROXY: 'http://127.0.0.1:1',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  ENABLE_TOOL_SEARCH: 'false',
});
const preload = resolve(dirname(out), '.controlled-preload-' + randomUUID() + '.cjs');
await writeFile(
  preload,
  "process.env.NODE_OPTIONS='--require=/CANARY_PARENT_PRELOAD_MUST_NOT_PASS';\n",
  { mode: 0o600, flag: 'wx' },
);
const harnessEnv = { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(preload) };
const result = await new Promise((resolveResult, reject) => {
  const child = spawn(
    process.execPath,
    [
      cli,
      'run',
      '--clients',
      resolve(clients),
      '--suite',
      'core',
      '--repeat',
      '2',
      '--out',
      out,
      '--json',
    ],
    { env: harnessEnv, stdio: ['ignore', 'pipe', 'inherit'], shell: false },
  );
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.once('error', reject);
  child.once('close', (code) => resolveResult({ code, stdout }));
});
const summary = JSON.parse(result.stdout),
  report = reportSchema.parse(JSON.parse(await readFile(resolve(out, 'report.json'), 'utf8')));
await rm(preload);
assert.equal(result.code, 1, 'Pinned clients have measured contract failures; exact exit expected');
assert.equal(summary.exitCode, report.exitCode);
assert.equal(report.cases.length, 24);
assert.deepEqual(
  new Set(report.cases.map((c) => c.nativeVersion)),
  new Set(['2.1.294', '2.1.296']),
);
for (const c of report.cases) {
  assert.equal(c.harnessStatus, 'complete', JSON.stringify(c.errors));
  assert.deepEqual(c.errors, []);
  assert(c.stages.every((s) => ['observed-pass', 'observed-fail'].includes(s.status)));
  assert.equal(c.continuity.proved, true);
  assert.equal(c.continuity.nonceReintroduced, false);
  assert.equal(c.provenance.authMethodBeforeDummy, 'none');
  assert.equal(c.provenance.verified, true);
  assert(
    c.evidence
      .filter((e) => e.event === 'request' && e.producer === 'model')
      .every((e) => e.data.syntheticCredentialValidated === true),
  );
  validateEvents(c.evidence);
  const expectedStatus = ['same-name', 'description-only', 'schema-only'].includes(c.scenario)
    ? 'observed-fail'
    : 'observed-pass';
  assert.equal(c.clientContractStatus, expectedStatus, `${c.nativeVersion} ${c.scenario}`);
  for (const stage of ['initial', 'notification', 'resume']) {
    const phase =
      stage === 'initial'
        ? c.scenario === 'fresh-b'
          ? 'B'
          : 'A'
        : c.scenario === 'no-change'
          ? 'A'
          : 'B';
    const short =
      c.scenario === 'added-tool' && stage !== 'initial' ? 'lookup_summary' : 'lookup_record';
    const expected = definitions({ scenario: c.scenario, phase }).find((d) => d.name === short);
    const recomputed = resolveDefinition(c.evidence, stage, 'mcp__canary__' + short, expected);
    assert.deepEqual(c.definitions[stage], recomputed);
    assert.equal(recomputed.status, 'resolved');
  }
  if (c.scenario === 'description-only') {
    assert.equal(c.definitions.resume.descriptionStatus, 'stale');
    assert.equal(c.definitions.resume.schemaStatus, 'current');
  }
  if (c.scenario === 'schema-only') {
    assert.equal(c.definitions.resume.descriptionStatus, 'current');
    assert.equal(c.definitions.resume.schemaStatus, 'stale');
  }
}
for (const version of ['2.1.294', '2.1.296'])
  for (const scenario of CORE) {
    const runs = report.cases.filter((c) => c.nativeVersion === version && c.scenario === scenario);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].clientContractStatus, runs[1].clientContractStatus);
    assert.notEqual(runs[0].id, runs[1].id);
  }
await writeFile(
  resolve(out, 'acceptance.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      nativeVerified: true,
      sourceCommit: report.sourceCommit,
      cases: 24,
      repeats: 2,
      versions: ['2.1.294', '2.1.296'],
      actualCliExitCode: result.code,
      harnessComplete: true,
      measuredClientFailures: report.cases.filter((c) => c.exitCode === 1).length,
      controlsPassed: true,
      report: 'report.json',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    nativeAcceptance: 'passed',
    out,
    cases: report.cases.length,
    sourceCommit: report.sourceCommit,
  }),
);
