import { mkdir, writeFile, readFile, realpath, rm, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CanaryError } from '../types.js';
import { within } from '../server/phase-control.js';
export const childSettings = {
  ENABLE_TOOL_SEARCH: 'true',
  MCP_CONNECTION_NONBLOCKING: '0',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
};
export function childEnvironment(
  config: string,
  endpoint?: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'])
    if (inherited[key]) env[key] = inherited[key];
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  Object.assign(env, childSettings, { CLAUDE_CONFIG_DIR: config, LANG: 'en_US.UTF-8' });
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.username || url.password)
      throw new CanaryError('Only credential-free loopback endpoint is allowed');
    env.ANTHROPIC_BASE_URL = endpoint;
    env.ANTHROPIC_AUTH_TOKEN = 'mcpclientcanary-synthetic-loopback-only';
  }
  return env;
}
export type Owned = {
  root: string;
  project: string;
  config: string;
  runId: string;
  control: string;
  serverEvidence: string;
  nonce: string;
};
export async function createOwned(parent: string): Promise<Owned> {
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink()) throw new CanaryError('Run parent is a symlink');
  const base = await realpath(parent),
    runId = randomUUID(),
    root = resolve(base, runId);
  await mkdir(root, { mode: 0o700 });
  await writeFile(resolve(root, '.canary-owner'), runId, { mode: 0o600, flag: 'wx' });
  const project = resolve(root, 'project'),
    config = resolve(root, 'config');
  await mkdir(project, { mode: 0o700 });
  await mkdir(config, { mode: 0o700 });
  return {
    root,
    project,
    config,
    runId,
    control: resolve(root, 'control.json'),
    serverEvidence: resolve(root, 'server.jsonl'),
    nonce: 'CANARY_NONCE_' + randomUUID(),
  };
}
export async function cleanupOwned(owned: Owned): Promise<void> {
  if (
    (await realpath(owned.root)) !== owned.root ||
    (await readFile(resolve(owned.root, '.canary-owner'), 'utf8')) !== owned.runId
  )
    throw new CanaryError('Cleanup ownership mismatch');
  for (const child of [owned.config, owned.project])
    await rm(await within(owned.root, child), { recursive: true, force: true });
  for (const name of ['mcp.json', 'settings.json'])
    await rm(await within(owned.root, resolve(owned.root, name)), { force: true });
}
