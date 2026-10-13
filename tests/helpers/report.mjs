import { readFile } from 'node:fs/promises';
import { runCase } from '../../dist/scenarios/state-machine.js';
import { aggregateExit } from '../../dist/verdict/contracts.js';

export const original = async () =>
  JSON.parse(
    await readFile(new URL('../../examples/recorded-report.json', import.meta.url), 'utf8'),
  );

export async function singleCase(scenario = 'same-name') {
  const r = await original();
  r.cases = [r.cases.find((c) => c.scenario === scenario)];
  r.exitCode = r.cases[0].exitCode;
  return r;
}

// Exercise the real early platform gate without launching any native executable.
export async function unsupportedReport(parent) {
  const r = await original();
  const c = await runCase(
    {
      label: 'Unsupported portable test',
      executable: '/not-provided/claude',
      expectedVersion: '2.1.294',
      expectedSha256: r.clients[0].expectedSha256,
      os: 'unsupported-test-platform',
      arch: 'arm64',
    },
    'same-name',
    1,
    parent,
    5000,
  );
  r.recorded = false;
  r.clients = [{ ...r.clients[0], label: c.client }];
  r.environment = { os: process.platform, arch: process.arch, node: process.version };
  r.cases = [c];
  r.exitCode = aggregateExit([c.exitCode]);
  return r;
}
