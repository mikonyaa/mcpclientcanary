import { readFile, writeFile, rename, lstat, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { type Control, controlSchema, CanaryError } from '../types.js';
export async function within(root: string, path: string): Promise<string> {
  const base = await realpath(root),
    target = resolve(path);
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new CanaryError('Path escapes owned run directory');
  let next = base;
  for (const part of rel.split('/').filter(Boolean)) {
    next = resolve(next, part);
    try {
      if ((await lstat(next)).isSymbolicLink()) throw new CanaryError('Symlink in controlled path');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return target;
}
export async function readControl(root: string, path: string): Promise<Control> {
  const target = await within(root, path);
  if ((await stat(target)).size > 65536) throw new CanaryError('Control file exceeds 64 KiB');
  return controlSchema.parse(JSON.parse(await readFile(target, 'utf8')));
}
export async function writeControl(root: string, path: string, control: Control): Promise<void> {
  controlSchema.parse(control);
  const target = await within(root, path);
  const temp = resolve(dirname(target), '.phase-' + control.runId + '.tmp');
  await within(root, temp);
  await writeFile(temp, JSON.stringify(control), { mode: 0o600, flag: 'wx' });
  await rename(temp, target);
}
