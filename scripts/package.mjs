import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const arg = process.argv.indexOf('--tgz');
let tgz;
if (arg >= 0) tgz = resolve(process.argv[arg + 1]);
else {
  const p = spawnSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const info = JSON.parse(p.stdout)[0];
  tgz = resolve(info.filename);
  const names = info.files.map((f) => f.path);
  assert(names.includes('dist/server/fixture-server.js'));
  assert(names.includes('schemas/report.schema.json'));
  assert(
    names.every(
      (p) => !p.includes('.local') && !p.startsWith('node_modules/') && !/claude$/.test(p),
    ),
  );
}
const consumer = await mkdtemp(join(tmpdir(), 'mcpclientcanary-consumer-'));
try {
  await writeFile(
    join(consumer, 'package.json'),
    '{"name":"clean-consumer","version":"1.0.0","private":true,"type":"module"}',
  );
  const install = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tgz],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(install.status, 0, install.stderr);
  const packageRoot = resolve(consumer, 'node_modules/mcpclientcanary'),
    cli = resolve(packageRoot, 'dist/cli/main.js');
  let result = spawnSync(process.execPath, [cli, '--version'], { cwd: consumer, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '0.1.0');
  assert.equal(result.stderr, '');
  const init = resolve(consumer, 'example');
  result = spawnSync(process.execPath, [cli, 'init', '--dir', init], {
    cwd: consumer,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const example = JSON.parse(await readFile(resolve(init, 'clients.example.json'), 'utf8'));
  assert.equal(example.clients.length, 2);
  result = spawnSync(
    process.execPath,
    [
      cli,
      'report',
      resolve(packageRoot, 'examples/recorded-report.json'),
      '--out',
      resolve(consumer, 'report.html'),
      '--json',
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert(JSON.parse(result.stdout).html);
  assert(
    (await readFile(resolve(consumer, 'report.html'), 'utf8')).includes('Follow the definition'),
  );
  result = spawnSync(
    process.execPath,
    [cli, 'demo', '--recorded', '--out', resolve(consumer, 'recorded'), '--json'],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).currentRuntimeTested, false);
  result = spawnSync(
    process.execPath,
    [
      cli,
      'run',
      '--clients',
      resolve(init, 'clients.example.json'),
      '--scenario',
      'same-name',
      '--repeat',
      '99',
      '--out',
      resolve(consumer, 'bad'),
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  // Run the compiled server from the installed package through an independent SDK client.
  const code = `import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';import {createOwned,childEnvironment} from 'mcpclientcanary/dist/native/isolation.js';import {writeControl} from 'mcpclientcanary/dist/server/phase-control.js';const owned=await createOwned('./owned');await writeControl(owned.root,owned.control,{schemaVersion:1,runId:owned.runId,scenario:'fresh-b',phase:'B',generation:1});const client=new Client({name:'package-server-check',version:'1'});try{await client.connect(new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(resolve(packageRoot, 'dist/server/fixture-server.js'))},owned.root,owned.control,owned.serverEvidence],env:childEnvironment(owned.config)}));const tools=await client.listTools();if(!tools.tools[0].inputSchema.required.includes('detail'))throw Error('B not served');}finally{await client.close();}`;
  await writeFile(resolve(consumer, 'server-check.mjs'), code);
  result = spawnSync(process.execPath, ['server-check.mjs'], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(packageRoot);
  assert(!files.includes('clients.local.json'));
  console.log(
    JSON.stringify({
      packageSmoke: 'passed',
      tgz,
      consumerOutsideSource: true,
      compiledServerFromInstalledPackage: true,
      recordedIsNotNativeCoverage: true,
    }),
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
