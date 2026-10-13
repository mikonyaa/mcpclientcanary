import { promises as fs, type Stats } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { CanaryError } from '../types.js';

type OwnedFile = { name: string; identity: Stats };
export type PublicationOptions = { signal?: AbortSignal };
const identityMatches = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
async function identity(path: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new CanaryError('Report publication cancelled', 130);
}
function conflict(path: string): CanaryError {
  return new CanaryError(
    `Output conflict at ${path}; choose a fresh directory or file. Existing output was preserved.`,
  );
}
export async function assertFreshOutput(path: string): Promise<void> {
  if (await identity(resolve(path))) throw conflict(resolve(path));
}
async function removeOwnedFile(path: string, owned: Stats): Promise<void> {
  const current = await identity(path);
  if (current && identityMatches(current, owned)) await fs.unlink(path);
}
async function removeOwnedDirectory(path: string, owned: Stats, files: OwnedFile[]): Promise<void> {
  const current = await identity(path);
  if (!current || !identityMatches(current, owned)) return;
  for (const file of files) await removeOwnedFile(join(path, file.name), file.identity);
  // rmdir refuses foreign contents; recursive removal is deliberately never used.
  try {
    await fs.rmdir(path);
  } catch (e) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? ''))
      throw e;
  }
}
function publicationError(e: unknown, path: string): CanaryError {
  if (e instanceof CanaryError) return e;
  const code = (e as NodeJS.ErrnoException).code;
  if (['EEXIST', 'ENOTEMPTY'].includes(code ?? '')) return conflict(path);
  if (code === 'ABORT_ERR') return new CanaryError('Report publication cancelled', 130);
  return new CanaryError(
    `Cannot publish report at ${path} (${code ?? 'I/O error'}); no partial bundle was committed. Check the parent directory permissions and choose a fresh output.`,
  );
}
async function stageFile(
  root: string,
  name: string,
  content: string,
  files: OwnedFile[],
  signal?: AbortSignal,
) {
  checkAbort(signal);
  const handle = await fs.open(join(root, name), 'wx', 0o600);
  try {
    files.push({ name, identity: await handle.stat() });
    await fs.writeFile(handle, content, { encoding: 'utf8', signal, flush: true });
  } finally {
    await handle.close();
  }
}

/** Complete files appear together at the directory rename; existing directories are refused. */
export async function publishBundle(
  out: string,
  contents: [string, string][],
  options: PublicationOptions = {},
): Promise<void> {
  out = resolve(out);
  checkAbort(options.signal);
  await assertFreshOutput(out);
  let staged: string | undefined, stagedIdentity: Stats | undefined, reserved: Stats | undefined;
  const files: OwnedFile[] = [];
  let committed = false;
  try {
    await fs.mkdir(dirname(out), { recursive: true });
    staged = await fs.mkdtemp(join(dirname(out), `.${basename(out)}-staging-`));
    await fs.chmod(staged, 0o700);
    stagedIdentity = await fs.lstat(staged);
    for (const [name, content] of contents)
      await stageFile(staged, name, content, files, options.signal);
    checkAbort(options.signal);
    await fs.mkdir(out, { mode: 0o700 }); // exclusive directory reservation
    reserved = await fs.lstat(out);
    checkAbort(options.signal);
    const current = await identity(out);
    if (!current || !identityMatches(current, reserved)) throw conflict(out);
    await fs.rename(staged, out); // same-filesystem, complete-directory publication
    committed = true;
    checkAbort(options.signal);
  } catch (e) {
    try {
      if (committed && stagedIdentity) await removeOwnedDirectory(out, stagedIdentity, files);
      else if (reserved) await removeOwnedDirectory(out, reserved, []);
      if (staged && stagedIdentity) await removeOwnedDirectory(staged, stagedIdentity, files);
    } catch (cleanup) {
      throw new CanaryError(
        `Report publication failed at ${out}; owned staging cleanup failed (${(cleanup as NodeJS.ErrnoException).code ?? 'I/O error'}). Diagnostic evidence was preserved.`,
        e instanceof CanaryError ? e.code : 2,
      );
    }
    throw publicationError(e, out);
  }
}

/** A single HTML file is committed by an exclusive hard link after the write is complete. */
export async function publishHtml(
  path: string,
  content: string,
  options: PublicationOptions = {},
): Promise<void> {
  path = resolve(path);
  checkAbort(options.signal);
  await assertFreshOutput(path);
  let staged: string | undefined, stagedIdentity: Stats | undefined;
  const files: OwnedFile[] = [];
  let committed = false;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    staged = await fs.mkdtemp(join(dirname(path), `.${basename(path)}-staging-`));
    stagedIdentity = await fs.lstat(staged);
    await stageFile(staged, 'report.html', content, files, options.signal);
    checkAbort(options.signal);
    await fs.link(join(staged, 'report.html'), path); // EEXIST; never clobbers an existing file/symlink
    committed = true;
    checkAbort(options.signal);
  } catch (e) {
    if (committed && files[0]) await removeOwnedFile(path, files[0].identity);
    throw publicationError(e, path);
  } finally {
    if (staged && stagedIdentity) await removeOwnedDirectory(staged, stagedIdentity, files);
  }
}
