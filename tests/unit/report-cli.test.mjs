import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { singleCase } from '../helpers/report.mjs';

test('JSON import errors have structured stderr and empty stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canary-cli-'));
  try {
    const r = await singleCase();
    r.exitCode = 0;
    const input = join(dir, 'bad.json');
    await writeFile(input, JSON.stringify(r));
    const p = spawnSync(
      process.execPath,
      ['dist/cli/main.js', 'report', input, '--out', join(dir, 'out.html'), '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(p.status, 2);
    assert.equal(p.stdout, '');
    const error = JSON.parse(p.stderr);
    assert.equal(error.exitCode, 2);
    assert.match(error.error.message, /integrity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('JSON output conflict is actionable and leaves all sentinel bytes intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canary-cli-'));
  try {
    await writeFile(join(dir, 'report.html'), 'SENTINEL');
    const p = spawnSync(
      process.execPath,
      ['dist/cli/main.js', 'demo', '--recorded', '--out', dir, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(p.status, 2);
    assert.equal(p.stdout, '');
    assert.match(JSON.parse(p.stderr).error.message, /conflict.*fresh/);
    assert.equal(await readFile(join(dir, 'report.html'), 'utf8'), 'SENTINEL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('SIGINT during capture gives exit 130 and retains a coherent cancellation report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canary-cli-cancel-'));
  try {
    const config = {
      schemaVersion: 1,
      clients: [
        {
          label: 'No supplied native binary',
          executable: join(dir, 'absent'),
          expectedVersion: '2.1.294',
          expectedSha256: 'def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53',
          os: 'darwin',
          arch: 'arm64',
        },
      ],
    };
    const file = join(dir, 'clients.json');
    await writeFile(file, JSON.stringify(config));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        'dist/cli/main.js',
        'run',
        '--clients',
        file,
        '--repeat',
        '1',
        '--out',
        join(dir, 'out'),
        '--json',
      ]);
      let stdout = '',
        stderr = '',
        sent = false;
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => {
        stderr += c;
        if (!sent) {
          sent = true;
          child.kill('SIGINT');
        }
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.code, 130, result.stderr);
    assert.equal(result.signal, null);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.exitCode, 130);
    const r = JSON.parse(await readFile(summary.report, 'utf8'));
    assert.equal(r.environment.cancelled, true);
    assert.match(await readFile(summary.html, 'utf8'), /Incomplete native coverage/);
    await readFile(join(summary.diagnostics, 'capture-report.diagnostic.json'), 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
