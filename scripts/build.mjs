import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { z } from 'zod';
const compile = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
  stdio: 'inherit',
});
if (compile.status !== 0) process.exit(compile.status ?? 2);
const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
const sourceCommit = /^[a-f0-9]{40}$/.test(git.stdout.trim()) ? git.stdout.trim() : 'uncommitted';
await writeFile(
  'dist/build-meta.json',
  JSON.stringify(
    {
      sourceCommit,
      buildOrigin: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local-source',
      node: process.version,
    },
    null,
    2,
  ) + '\n',
);
await chmod('dist/cli/main.js', 0o755);
const { clientsSchema, controlSchema, reportSchema } = await import('../dist/types.js');
await mkdir('schemas', { recursive: true });
for (const [name, schema] of [
  ['clients', clientsSchema],
  ['control', controlSchema],
  ['report', reportSchema],
])
  await writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }), null, 2) + '\n',
  );
