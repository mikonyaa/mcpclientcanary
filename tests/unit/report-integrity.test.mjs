import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadReport } from '../../dist/report/index.js';
import { htmlReport } from '../../dist/report/html.js';
import { digest } from '../../dist/evidence/collector.js';
import { original, singleCase, unsupportedReport } from '../helpers/report.mjs';

const mutations = {
  'event data without digest': (r) => (r.cases[0].evidence[0].data.verified = false),
  'fabricated case summary': (r) => {
    Object.assign(r.cases[0], {
      harnessStatus: 'complete',
      clientContractStatus: 'observed-pass',
      exitCode: 0,
    });
    r.exitCode = 0;
  },
  'fabricated top exit': (r) => (r.exitCode = 0),
  'changed stage verdict with matching aggregates': (r) => {
    for (const s of r.cases[0].stages) if (s.status === 'observed-fail') s.status = 'observed-pass';
    r.cases[0].clientContractStatus = 'observed-pass';
    r.cases[0].exitCode = 0;
    r.exitCode = 0;
  },
  'duplicate case id': (r) => r.cases.push(structuredClone(r.cases[0])),
  'duplicate stage': (r) => r.cases[0].stages.push(structuredClone(r.cases[0].stages[0])),
  'missing stage': (r) => r.cases[0].stages.splice(3, 1),
  'missing stage reference': (r) => r.cases[0].stages[0].evidenceRefs.push('missing'),
  'duplicate stage reference': (r) =>
    r.cases[0].stages[0].evidenceRefs.push(r.cases[0].stages[0].evidenceRefs[0]),
  'wrong existing reference': (r) =>
    (r.cases[0].stages[0].evidenceRefs[0] = r.cases[0].evidence[1].ref),
  'duplicate evidence': (r) => r.cases[0].evidence.push(structuredClone(r.cases[0].evidence[0])),
  'missing sequence': (r) => r.cases[0].evidence.splice(1, 1),
  'fabricated definition summary': (r) =>
    (r.cases[0].definitions.notification.schemaStatus = 'current'),
  'fabricated historical definition': (r) =>
    r.cases[0].definitions.initial.historical.push({ name: 'invented' }),
  'invalid continuity summary': (r) => (r.cases[0].continuity.initialSessionId = 'other-session'),
  'invalid rehashed continuity observation': (r) => {
    const e = r.cases[0].evidence.find(
      (e) => e.producer === 'native' && e.event === 'init' && e.data.resumeRequested,
    );
    e.data.resumeRequested = 'other-session';
    e.digest = digest(e.data);
  },
  'invalid rehashed capture linkage': (r) => {
    const e = r.cases[0].evidence.find((e) => e.event === 'search-result-observed');
    e.data.captureRef = r.cases[0].evidence[0].ref;
    e.digest = digest(e.data);
  },
  'invalid rehashed checkpoint link': (r) => {
    const e = r.cases[0].evidence.find((e) => e.event === 'observation-checkpoint');
    e.data.serverCheckpointRef = r.cases[0].evidence[0].ref;
    e.digest = digest(e.data);
  },
  'invalid observation window': (r) => (r.cases[0].window.actualNotificationWaitMs = 0),
  'wrong fixture hash': (r) => (r.cases[0].fixtureHash = '0'.repeat(64)),
  'wrong lifecycle phase': (r) => {
    for (const e of r.cases[0].evidence)
      if (e.producer === 'model' && e.data.stage === 'initial') e.phase = 'B';
  },
  'missing window with downstream observations': (r) => {
    r.cases[0].evidence.find((e) => e.event === 'notification-window-complete').event =
      'removed-window';
    r.cases[0].window.actualNotificationWaitMs = 0;
  },
  'reused checkpoint acknowledgement': (r) => {
    const points = r.cases[0].evidence.filter((e) => e.event === 'observation-checkpoint');
    for (const e of points.slice(1)) {
      e.data.serverCheckpointRef = points[0].data.serverCheckpointRef;
      e.data.barrierToken = points[0].data.barrierToken;
      e.digest = digest(e.data);
    }
  },
  'swapped checkpoint stages': (r) => {
    const points = r.cases[0].evidence.filter((e) => e.event === 'observation-checkpoint');
    const initial = structuredClone(points[0].data);
    for (const key of ['serverCheckpointRef', 'barrierToken']) {
      points[0].data[key] = points[2].data[key];
      points[2].data[key] = initial[key];
    }
    for (const e of [points[0], points[2]]) e.digest = digest(e.data);
  },
  'notification session mismatch': (r) => {
    const e = r.cases[0].evidence.find(
      (e) =>
        e.producer === 'native' && e.event === 'turn-complete' && e.data.stage === 'notification',
    );
    e.data.sessionId = '00000000-0000-4000-8000-000000000000';
    e.digest = digest(e.data);
  },
  'notification process mismatch': (r) => {
    const e = r.cases[0].evidence.find(
      (e) =>
        e.producer === 'native' && e.event === 'turn-complete' && e.data.stage === 'notification',
    );
    e.pid = 123456789;
  },
};

test('original 24 cases reopen without changing evidence or twelve observed failures', async () => {
  const r = await loadReport('examples/recorded-report.json');
  assert.equal(r.cases.length, 24);
  assert.equal(
    r.cases.reduce((n, c) => n + c.evidence.length, 0),
    1488,
  );
  assert.equal(r.cases.filter((c) => c.exitCode === 1).length, 12);
  assert.deepEqual(r, await original());
});

for (const [name, mutate] of Object.entries(mutations))
  test(`import rejects ${name} before HTML publication`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canary-integrity-'));
    try {
      const r = await singleCase();
      mutate(r);
      const input = join(dir, 'report.json'),
        out = join(dir, 'success.html');
      await writeFile(input, JSON.stringify(r));
      const p = spawnSync(
        process.execPath,
        ['dist/cli/main.js', 'report', input, '--out', out, '--json'],
        { encoding: 'utf8' },
      );
      assert.equal(p.status, 2, p.stderr);
      assert.equal(p.stdout, '');
      assert.match(p.stderr, /report|evidence|integrity/i);
      await assert.rejects(access(out));
      await assert.rejects(loadReport(input));
      assert.throws(() => htmlReport(r));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test('real early unsupported path remains a valid incomplete import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canary-unsupported-'));
  try {
    const r = await unsupportedReport(join(dir, 'runs'));
    assert.equal(r.exitCode, 3);
    assert.equal(r.cases[0].harnessStatus, 'incomplete');
    const file = join(dir, 'report.json');
    await writeFile(file, JSON.stringify(r));
    assert.deepEqual(await loadReport(file), r);
    assert.match(htmlReport(r), /Incomplete native coverage/);
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(r));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
