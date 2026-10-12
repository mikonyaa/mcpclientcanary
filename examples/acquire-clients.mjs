#!/usr/bin/env node
// Explicit acquisition only. No install/login/logout or changes to an existing Claude profile.
import { mkdir, writeFile, readFile, chmod, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const pinned = {
  '2.1.294': 'def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53',
  '2.1.296': 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937',
};
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('These pinned distributions are macOS arm64 only');
const argv = process.argv.slice(2);
const index = argv.indexOf('--cache');
if (index < 0 || !argv[index + 1])
  throw Error(
    'Usage: node acquire-clients.mjs --cache ./canary-cache [--manifest ./clients.local.json]',
  );
const cache = resolve(argv[index + 1]);
await mkdir(cache, { recursive: true, mode: 0o700 });
if ((await lstat(cache)).isSymbolicLink()) throw Error('Cache may not be a symlink');
const canonical = await realpath(cache);
if (canonical !== cache) throw Error('Use the canonical cache path');
const marker = resolve(cache, '.canary-cache');
try {
  if ((await readFile(marker, 'utf8')) !== 'mcpclientcanary-native-cache-v1')
    throw Error('Foreign cache');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  if ((await readdir(cache)).length) throw Error('Refusing to claim a nonempty directory');
  await writeFile(marker, 'mcpclientcanary-native-cache-v1', { mode: 0o600, flag: 'wx' });
}
const clients = [];
for (const [version, expectedSha256] of Object.entries(pinned)) {
  const base = `https://downloads.claude.ai/claude-code-releases/${version}`;
  const response = await fetch(base + '/manifest.json');
  if (!response.ok) throw Error('Official manifest HTTP ' + response.status);
  const manifest = await response.json();
  if (manifest.platforms?.['darwin-arm64']?.checksum !== expectedSha256)
    throw Error('Official manifest changed; stop and review adapter support');
  const dir = resolve(cache, version);
  await mkdir(dir, { mode: 0o700 });
  const executable = resolve(dir, 'claude');
  const binary = await fetch(base + '/darwin-arm64/claude');
  if (!binary.ok) throw Error('Official binary HTTP ' + binary.status);
  const bytes = Buffer.from(await binary.arrayBuffer());
  if (
    bytes.length > 512 * 1024 * 1024 ||
    createHash('sha256').update(bytes).digest('hex') !== expectedSha256
  )
    throw Error('Official binary size/hash mismatch');
  await writeFile(executable, bytes, { mode: 0o755, flag: 'wx' });
  await chmod(executable, 0o755);
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  clients.push({
    label: 'Claude Code ' + version,
    executable,
    expectedVersion: version,
    expectedSha256,
    os: 'darwin',
    arch: 'arm64',
  });
  console.error(`Acquired official ${version} darwin-arm64; SHA-256 verified`);
}
const outputIndex = argv.indexOf('--manifest');
const output = resolve(outputIndex >= 0 ? argv[outputIndex + 1] : 'clients.local.json');
await writeFile(output, JSON.stringify({ schemaVersion: 1, clients }, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
console.log('Wrote ' + output);
