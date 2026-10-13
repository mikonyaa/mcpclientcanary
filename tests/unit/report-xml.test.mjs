import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junitReport, writeReports } from '../../dist/report/index.js';
import { clientSchema } from '../../dist/types.js';
import { singleCase } from '../helpers/report.mjs';

const labels = [
  ['normal', 'Claude & "quoted" <label>', 'Claude & "quoted" <label>'],
  ['FFFE', 'Claude\uFFFE', 'Claude[U+FFFE]'],
  ['FFFF', 'Claude\uFFFF', 'Claude[U+FFFF]'],
  ['controls', 'Claude\u0000\u0001\u000B\u001B', 'Claude[U+0000][U+0001][U+000B][U+001B]'],
  ['surrogates', 'Claude\uD800x\uDC00', 'Claude[U+D800]x[U+DC00]'],
  ['astral', 'Claude 😀 𝄞', 'Claude 😀 𝄞'],
  ['whitespace', 'Claude\t\n\r label', 'Claude\t\n\r label'],
  ['allowed-noncharacters', 'Claude\uFDD0\u{1FFFE}', 'Claude\uFDD0\u{1FFFE}'],
];
const parse = (xml) =>
  spawnSync(
    'python3',
    [
      '-c',
      'import sys,json,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.buffer.read()); print(json.dumps({"label":r.find("testcase").attrib["classname"],"tests":r.attrib["tests"],"failures":r.attrib["failures"],"reason":r.find("testcase/failure").text},ensure_ascii=True))',
    ],
    { input: xml, encoding: 'utf8' },
  );
for (const [name, label, expected] of labels)
  test(`independent XML 1.0 parser accepts ${name} without changing JSON`, async () => {
    const r = await singleCase();
    const previous = r.cases[0].client;
    r.cases[0].client = label;
    r.clients.find((c) => c.label === previous).label = label;
    assert(
      clientSchema.safeParse({
        label,
        executable: '/not-executed',
        expectedVersion: '2.1.294',
        expectedSha256: r.clients[0].expectedSha256,
        os: 'darwin',
        arch: 'arm64',
      }).success,
    );
    const dir = await mkdtemp(join(tmpdir(), 'canary-xml-'));
    try {
      await writeReports(r, join(dir, 'bundle'));
      const json = JSON.parse(await readFile(join(dir, 'bundle', 'report.json'), 'utf8'));
      assert.equal(json.cases[0].client, label);
      const result = parse(await readFile(join(dir, 'bundle', 'junit.xml'), 'utf8'));
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.label, expected);
      assert.equal(parsed.tests, '1');
      assert.equal(parsed.failures, '1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
test('failure reason uses XML encoding in text as well as attributes', async () => {
  const r = await singleCase();
  r.cases[0].stages.find((s) => s.status === 'observed-fail').reason = 'reason < & \uFFFE\u0001😀';
  const result = parse(junitReport(r));
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /reason < & \[U\+FFFE\]\[U\+0001\]😀/);
});
