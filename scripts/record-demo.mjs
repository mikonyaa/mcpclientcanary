import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const argv = process.argv.slice(2),
  clientIndex = argv.indexOf('--clients'),
  cliIndex = argv.indexOf('--cli');
if (clientIndex < 0 || cliIndex < 0)
  throw Error('Use --clients <manifest> --cli <installed bin> --work <new dir>');
const workIndex = argv.indexOf('--work'),
  work = resolve(argv[workIndex + 1]);
await mkdir(work, { recursive: false });
await writeFile(
  resolve(work, 'clients.local.json'),
  await readFile(resolve(argv[clientIndex + 1])),
);
const cli = resolve(argv[cliIndex + 1]),
  lines = [
    JSON.stringify({
      version: 2,
      width: 116,
      height: 38,
      timestamp: Math.floor(Date.now() / 1000),
      title: 'MCPClientCanary: actual native synthetic workflow, two pinned versions',
      env: { TERM: 'xterm-256color' },
    }),
  ];
const start = performance.now();
const emit = (text) =>
  lines.push(
    JSON.stringify([(performance.now() - start) / 1000, 'o', text.replaceAll('\n', '\r\n')]),
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function command(args) {
  emit('$ mcpclientcanary ' + args.join(' ') + '\n');
  const result = await new Promise((res, rej) => {
    const p = spawn(cli, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => emit(String(c)));
    p.once('error', rej);
    p.once('close', (code) => res({ code, stdout }));
  });
  return result;
}
emit(
  'Actual CLI workflow. Synthetic loopback; no model inference. Public output projection removes local paths.\n\n',
);
const doctor = await command(['doctor', '--clients', './clients.local.json', '--json']);
assert.equal(doctor.code, 0);
const d = JSON.parse(doctor.stdout);
emit(
  JSON.stringify(
    d.clients.map((c) => ({
      version: c.nativeVersion,
      verified: c.verified,
      sha256: c.sha256,
      cleanAuth: c.authMethodBeforeDummy,
    })),
    null,
    2,
  ) + '\n\n',
);
await pause(1500);
const demo = await command([
  'demo',
  '--clients',
  './clients.local.json',
  '--out',
  './demo-results',
  '--json',
]);
assert.equal(demo.code, 1);
const report = JSON.parse(await readFile(resolve(work, 'demo-results/report.json'), 'utf8'));
emit('Actual native run completed. Inspecting its captured evidence:\n');
for (const c of report.cases.filter((c) => c.repeat === 1)) {
  const events = c.evidence;
  const initial = c.definitions.initial,
    current = c.definitions.notification,
    resume = c.definitions.resume;
  const b = events.find(
    (e) =>
      e.producer === 'server' &&
      e.event === 'sent' &&
      e.data.method === 'tools/list' &&
      e.generation === 2,
  );
  emit(`\nClaude Code ${c.nativeVersion}\n`);
  emit(`  Native initial ToolSearch: ${initial.current.description}\n`);
  emit(`  Same live server served: ${b.data.tools[0].description}\n`);
  emit(
    `  After notification: description ${current.descriptionStatus}; schema ${current.schemaStatus}\n`,
  );
  emit(
    `  After native resume: description ${resume.descriptionStatus}; schema ${resume.schemaStatus}\n`,
  );
  emit(`  Same session and prior nonce: ${c.continuity.proved}\n`);
  await pause(2500);
}
emit(
  '\nHarness complete. Exit 1 = measured client contract violation.\nOpen report.html to inspect server / loaded reference / current input / resume.\n',
);
const remaining = 24000 - (performance.now() - start);
if (remaining > 0) await pause(remaining);
emit('\nRecorded workflow ended. Reading pauses are included; no fabricated CLI output.\n');
await writeFile('site/demo.cast', lines.join('\n') + '\n');
const data = JSON.stringify(lines.slice(1).map((l) => JSON.parse(l))).replaceAll('<', '\\u003c');
await writeFile(
  'site/demo.html',
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCPClientCanary · terminal recording</title><style>body{margin:0;padding:30px;background:#f4f4ef;color:#1c2d35;font:16px/1.6 'Avenir Next',sans-serif}main{max-width:1050px;margin:auto}h1{font-size:28px}button,a{color:inherit}button{padding:10px 18px;cursor:pointer;background:#e8c54e;border:1px solid #1c2d35;font:inherit}button:focus-visible,a:focus-visible{outline:3px solid #805e11;outline-offset:3px}pre{background:#1c2d35;color:#fff;padding:22px;border-top:5px solid #e8c54e;font:13px/1.6 Menlo,Consolas,monospace;max-height:650px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}</style><main><a href="./index.html">← Evidence report</a><h1>Actual native terminal workflow</h1><p>Two pinned Claude Code versions. Synthetic loopback; no inference. Local paths are removed from public output. This is a recorded experiment.</p><button id="play">Play 24-second recording</button> <a href="./demo.cast" download>Download .cast</a><pre id="terminal" tabindex="0" aria-label="Recorded terminal output">Select Play to start.</pre><p>Reading pauses are included. The recording executes doctor and a native demo, then inspects actual captured evidence.</p></main><script type="application/json" id="frames">${data}</script><script>const frames=JSON.parse(document.querySelector('#frames').textContent);let timers=[];document.querySelector('#play').onclick=()=>{timers.forEach(clearTimeout);timers=[];const term=document.querySelector('#terminal');term.textContent='';for(const frame of frames)timers.push(setTimeout(()=>{term.textContent+=frame[2];term.scrollTop=term.scrollHeight;},frame[0]*1000));};</script></html>`,
);
console.log(
  JSON.stringify({
    terminalRecording: 'actual-cli',
    seconds: Math.round((performance.now() - start) / 1000),
    sourceCommit: report.sourceCommit,
    versions: [...new Set(report.cases.map((c) => c.nativeVersion))],
    cases: report.cases.length,
    output: 'site/demo.cast',
  }),
);
