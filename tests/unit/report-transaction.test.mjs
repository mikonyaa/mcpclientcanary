import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReports } from '../../dist/report/index.js';
import { singleCase } from '../helpers/report.mjs';

const names = ['report.json', 'report.html', 'junit.xml'];
async function inTemp(fn) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'canary-transaction-'));
  try {
    await fn(dir);
  } finally {
    mock.restoreAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
for (const name of names)
  test(`bundle collision at ${name} preserves sentinel and writes nothing else`, () =>
    inTemp(async (dir) => {
      const out = join(dir, 'out');
      await fs.mkdir(out);
      await fs.writeFile(join(out, name), 'SENTINEL');
      await assert.rejects(
        writeReports(await singleCase(), out),
        (e) => e.code === 2 && /conflict.*fresh/i.test(e.message),
      );
      assert.deepEqual(await fs.readdir(out), [name]);
      assert.equal(await fs.readFile(join(out, name), 'utf8'), 'SENTINEL');
      assert.deepEqual(await fs.readdir(dir), ['out']);
    }));
test('complete bundle publishes to a missing parent', () =>
  inTemp(async (dir) => {
    const out = join(dir, 'new parent', 'out');
    await writeReports(await singleCase(), out);
    assert.deepEqual((await fs.readdir(out)).sort(), [...names].sort());
    for (const name of names) assert((await fs.stat(join(out, name))).size > 0);
  }));
test('forced staging write failure leaves no ready files', () =>
  inTemp(async (dir) => {
    const original = fs.writeFile;
    let writes = 0;
    mock.method(fs, 'writeFile', async (...args) => {
      if (++writes === 2) throw Object.assign(new Error('forced I/O failure'), { code: 'EIO' });
      return original(...args);
    });
    await assert.rejects(writeReports(await singleCase(), join(dir, 'out')));
    assert.deepEqual(await fs.readdir(dir), []);
  }));
test('forced commit failure rolls back only the owned reservation', () =>
  inTemp(async (dir) => {
    mock.method(fs, 'rename', async () => {
      throw Object.assign(new Error('forced rename failure'), { code: 'EIO' });
    });
    await assert.rejects(writeReports(await singleCase(), join(dir, 'out')));
    assert.deepEqual(await fs.readdir(dir), []);
  }));
test('pre-aborted publication produces no bundle', () =>
  inTemp(async (dir) => {
    const signal = AbortSignal.abort();
    await assert.rejects(
      writeReports(await singleCase(), join(dir, 'out'), { signal }),
      (e) => e.code === 130,
    );
    assert.deepEqual(await fs.readdir(dir), []);
  }));
test('abort after reservation rolls back all owned entries', () =>
  inTemp(async (dir) => {
    const controller = new AbortController(),
      original = fs.mkdir,
      out = join(dir, 'out');
    mock.method(fs, 'mkdir', async (...args) => {
      const result = await original(...args);
      if (args[0] === out) controller.abort();
      return result;
    });
    await assert.rejects(
      writeReports(await singleCase(), out, { signal: controller.signal }),
      (e) => e.code === 130,
    );
    assert.deepEqual(await fs.readdir(dir), []);
  }));
test('abort during commit rolls back the whole published bundle', () =>
  inTemp(async (dir) => {
    const controller = new AbortController(),
      original = fs.rename;
    mock.method(fs, 'rename', async (...args) => {
      await original(...args);
      controller.abort();
    });
    await assert.rejects(
      writeReports(await singleCase(), join(dir, 'out'), { signal: controller.signal }),
      (e) => e.code === 130,
    );
    assert.deepEqual(await fs.readdir(dir), []);
  }));
test('rollback unlink failure cannot leave partial files at the ready path', () =>
  inTemp(async (dir) => {
    const controller = new AbortController(),
      rename = fs.rename,
      unlink = fs.unlink,
      out = join(dir, 'out');
    mock.method(fs, 'rename', async (...args) => {
      await rename(...args);
      controller.abort();
    });
    let unlinks = 0;
    mock.method(fs, 'unlink', async (...args) => {
      if (++unlinks === 2)
        throw Object.assign(new Error('rollback unlink failed'), { code: 'EIO' });
      return unlink(...args);
    });
    await assert.rejects(
      writeReports(await singleCase(), out, { signal: controller.signal }),
      (e) => e.code === 130,
    );
    await assert.rejects(fs.access(out));
  }));
test('failed withdrawal preserves a complete bundle rather than deleting ready files', () =>
  inTemp(async (dir) => {
    const controller = new AbortController(),
      rename = fs.rename,
      out = join(dir, 'out');
    let calls = 0;
    mock.method(fs, 'rename', async (...args) => {
      if (++calls === 2) throw Object.assign(new Error('withdrawal failed'), { code: 'EIO' });
      await rename(...args);
      controller.abort();
    });
    await assert.rejects(
      writeReports(await singleCase(), out, { signal: controller.signal }),
      (e) => e.code === 130 && /Complete bundle preserved/.test(e.message),
    );
    assert.deepEqual((await fs.readdir(out)).sort(), [...names].sort());
    JSON.parse(await fs.readFile(join(out, 'report.json'), 'utf8'));
  }));
test('foreign directory replacement at commit survives rollback', () =>
  inTemp(async (dir) => {
    const out = join(dir, 'out'),
      original = fs.rename;
    mock.method(fs, 'rename', async (...args) => {
      await fs.rmdir(out);
      await fs.mkdir(out);
      await fs.writeFile(join(out, 'foreign'), 'SENTINEL');
      return original(...args);
    });
    await assert.rejects(writeReports(await singleCase(), out));
    assert.deepEqual(await fs.readdir(dir), ['out']);
    assert.deepEqual(await fs.readdir(out), ['foreign']);
    assert.equal(await fs.readFile(join(out, 'foreign'), 'utf8'), 'SENTINEL');
  }));
test('output symlink does not alter its foreign target', () =>
  inTemp(async (dir) => {
    const target = join(dir, 'foreign');
    await fs.mkdir(target);
    await fs.writeFile(join(target, 'sentinel'), 'SENTINEL');
    const out = join(dir, 'out');
    await fs.symlink(target, out);
    await assert.rejects(writeReports(await singleCase(), out));
    assert.deepEqual(await fs.readdir(target), ['sentinel']);
    assert((await fs.lstat(out)).isSymbolicLink());
  }));
test('permission-denied parent does not leave a partial bundle', () =>
  inTemp(async (dir) => {
    const parent = join(dir, 'locked');
    await fs.mkdir(parent, 0o500);
    try {
      await assert.rejects(writeReports(await singleCase(), join(parent, 'out')));
      assert.deepEqual(await fs.readdir(parent), []);
    } finally {
      await fs.chmod(parent, 0o700);
    }
  }));
