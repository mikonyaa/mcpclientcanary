import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateReport } from '../../dist/report/validate.js';
import { htmlReport } from '../../dist/report/html.js';
import { singleCase } from '../helpers/report.mjs';
test('recorded presentation does not change an interrupted suite outcome', async () => {
  const r = await singleCase('no-change');
  r.environment.cancelled = true;
  r.exitCode = 130;
  for (const recorded of [false, true]) {
    r.recorded = recorded;
    assert.equal(validateReport(r).exitCode, 130);
    assert.match(htmlReport(r), /Incomplete native coverage/);
  }
});
test('actual capture logic retains late diagnostic notification without promoting a timed-out trigger', () => {
  const p = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', 'tests/helpers/late-notification.mjs'],
    { encoding: 'utf8' },
  );
  assert.equal(p.status, 0, p.stderr);
  const r = JSON.parse(p.stdout),
    c = r.cases[0];
  assert.equal(c.exitCode, 3);
  assert.equal(c.harnessStatus, 'incomplete');
  assert(c.evidence.some((e) => e.event === 'notification-complete'));
  assert.equal(c.stages.find((s) => s.id === 'notification-trigger').status, 'not-reached');
  assert.deepEqual(validateReport(r), r);
  assert.match(htmlReport(r), /Incomplete native coverage/);
});
