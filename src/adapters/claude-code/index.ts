import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { type ClientConfig, SUPPORTED, CanaryError, obj } from '../../types.js';
import { childEnvironment, type Owned } from '../../native/isolation.js';
const exec = promisify(execFile);
export const officialHashes: Record<string, string> = {
  '2.1.294': 'def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53',
  '2.1.296': 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937',
};
export async function verifyClient(c: ClientConfig, owned: Owned, allowUnverified = false) {
  if (process.platform !== c.os || process.arch !== c.arch)
    throw new CanaryError('Adapter is verified only on macOS arm64', 3);
  const executable = await realpath(c.executable),
    s = await stat(executable);
  if (!s.isFile() || s.size > 512 * 1024 * 1024) throw new CanaryError('Invalid executable file');
  const sha256 = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  if (sha256 !== c.expectedSha256)
    throw new CanaryError('Executable SHA-256 differs from expected manifest');
  const env = childEnvironment(owned.config);
  const v = await exec(executable, ['--version'], {
    env,
    cwd: owned.project,
    timeout: 15000,
    maxBuffer: 65536,
  });
  const version = v.stdout.trim().split(' ')[0];
  if (version !== c.expectedVersion)
    throw new CanaryError('Executable version differs from expected version');
  const verified =
    SUPPORTED.includes(version as (typeof SUPPORTED)[number]) &&
    officialHashes[version!] === sha256;
  if (!verified && !allowUnverified)
    throw new CanaryError(
      'Native version or official distribution hash unverified; diagnostic --allow-unverified keeps coverage unverified',
      3,
    );
  const h = await exec(executable, ['--help'], {
    env,
    cwd: owned.project,
    timeout: 15000,
    maxBuffer: 128 * 1024,
  });
  for (const flag of [
    '--resume',
    '--input-format',
    '--output-format',
    '--strict-mcp-config',
    '--setting-sources',
    '--tools',
  ])
    if (!h.stdout.includes(flag))
      throw new CanaryError('Native CLI primitive unavailable: ' + flag, 3);
  let auth: Record<string, unknown>;
  try {
    const a = await exec(executable, ['auth', 'status'], {
      env,
      cwd: owned.project,
      timeout: 15000,
      maxBuffer: 65536,
    });
    auth = obj(JSON.parse(a.stdout));
  } catch (e) {
    const result = e as { stdout?: string; code?: number };
    if (result.code !== 1 || !result.stdout)
      throw new CanaryError('Isolated native auth status could not be verified');
    auth = obj(JSON.parse(result.stdout));
  }
  if (
    auth.loggedIn !== false ||
    auth.authMethod !== 'none' ||
    auth.configDirectory !== owned.config
  )
    throw new CanaryError('Clean config did not isolate authentication', 3);
  return {
    executable,
    local: { realpath: executable, sha256, nativeVersion: version },
    public: {
      executable: basename(executable),
      executablePathHash: createHash('sha256').update(executable).digest('hex'),
      sha256,
      nativeVersion: version,
      os: process.platform,
      arch: process.arch,
      verified,
      authMethodBeforeDummy: 'none',
      configDirectoryConfirmed: true,
      keychainIsolation: 'documented CLAUDE_CONFIG_DIR namespace + clean auth status',
      helpFlagsVerified: true,
    },
  };
}
export function nativeArgs(mcp: string, resume?: string): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    'ToolSearch',
    '--allowedTools',
    'ToolSearch,mcp__canary__*',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--mcp-config',
    mcp,
    '--setting-sources',
    '',
    '--model',
    'claude-sonnet-4-6',
    '--max-turns',
    '6',
    '--no-chrome',
  ];
  return resume ? [...args, '--resume', resume] : args;
}
