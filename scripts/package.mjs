import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const arg = process.argv.indexOf('--tgz');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
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
const consumer = await mkdtemp(join(tmpdir(), 'mcpclientcanary consumer Юникод-'));
try {
  await writeFile(
    join(consumer, 'package.json'),
    '{"name":"clean-consumer","version":"1.0.0","private":true,"type":"module"}',
  );
  const install = spawnSync(
    'npm',
    ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(install.status, 0, install.stderr);
  const packageRoot = resolve(consumer, 'node_modules/mcpclientcanary'),
    cli = resolve(packageRoot, 'dist/cli/main.js');
  let result = spawnSync(process.execPath, [cli, '--version'], { cwd: consumer, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
  assert.equal(result.stderr, '');
  const init = resolve(consumer, 'example каталог with spaces');
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
      'report',
      resolve(consumer, 'recorded/report.json'),
      '--out',
      resolve(consumer, 'reopened Юникод report.html'),
      '--json',
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(await readFile(resolve(consumer, 'recorded/report.json'), 'utf8')).cases.filter(
      (c) => c.exitCode === 1,
    ).length,
    12,
  );
  await assert.rejects(access(resolve(consumer, 'node_modules/typescript')));
  await assert.rejects(access(resolve(consumer, 'node_modules/playwright')));
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
  // A separate consumer speaks JSON-RPC over stdio without an SDK client.
  const rawCode = `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {createOwned,cleanupOwned,childEnvironment} from 'mcpclientcanary/dist/native/isolation.js';import {writeControl} from 'mcpclientcanary/dist/server/phase-control.js';const owned=await createOwned('./raw owned каталог');await writeControl(owned.root,owned.control,{schemaVersion:1,runId:owned.runId,scenario:'fresh-b',phase:'B',generation:1});const child=spawn(process.execPath,[${JSON.stringify(resolve(packageRoot, 'dist/server/fixture-server.js'))},owned.root,owned.control,owned.serverEvidence],{env:childEnvironment(owned.config),stdio:['pipe','pipe','pipe'],shell:false});const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',c=>stderr+=c);const waiters=new Map();lines.on('line',line=>{try{const r=JSON.parse(line);if(waiters.has(r.id)){waiters.get(r.id)(r);waiters.delete(r.id);}}catch(e){throw e;}});const request=(id,method,params)=>new Promise(r=>{waiters.set(id,r);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});const timer=setTimeout(()=>child.kill('SIGTERM'),10000);try{const init=await request(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'independent-raw-consumer',version:'1'}});if(init.result?.protocolVersion!=='2025-11-25')throw Error('Protocol negotiation failed');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');const tools=await request(2,'tools/list',{});if(!tools.result?.tools[0]?.inputSchema.required.includes('detail'))throw Error('Raw consumer B schema missing');const closed=new Promise(r=>child.once('close',r));child.stdin.end();const code=await closed;if(code!==0||stderr)throw Error('Fixture failed: '+stderr);}finally{clearTimeout(timer);lines.close();if(child.exitCode===null)child.kill('SIGTERM');await cleanupOwned(owned);}`;
  await writeFile(resolve(consumer, 'raw-server-check.mjs'), rawCode);
  result = spawnSync(process.execPath, ['raw-server-check.mjs'], {
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
      rawJsonRpcConsumer: true,
      devDependenciesAbsent: true,
      unicodeSpacePaths: true,
      recordedIsNotNativeCoverage: true,
    }),
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
