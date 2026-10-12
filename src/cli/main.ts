#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  VERSION,
  ADAPTER_VERSION,
  PROTOCOL,
  CORE,
  scenarioSchema,
  clientsSchema,
  CanaryError,
  type Report,
  type ClientConfig,
  type CaseResult,
} from '../types.js';
import { createOwned, cleanupOwned } from '../native/isolation.js';
import { verifyClient, officialHashes } from '../adapters/claude-code/index.js';
import { runCase } from '../scenarios/state-machine.js';
import { aggregateExit } from '../verdict/contracts.js';
import { loadReport, writeReports, writeHtml } from '../report/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function clients(path: string): Promise<ClientConfig[]> {
  if ((await stat(path)).size > 65536) throw new CanaryError('Client manifest exceeds 64 KiB');
  const list = clientsSchema.parse(JSON.parse(await readFile(path, 'utf8'))).clients;
  if (
    new Set(list.map((c) => c.executable)).size !== list.length ||
    new Set(list.map((c) => c.expectedVersion)).size !== list.length
  )
    throw new CanaryError('Client versions and executable paths must be distinct');
  return list;
}
const bounded = (min: number, max: number) => (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new InvalidArgumentError(`Expected integer ${min}..${max}`);
  return n;
};
const plain = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
const print = (data: unknown, json: boolean, message: string) =>
  process.stdout.write(json ? JSON.stringify(data) + '\n' : message + '\n');
type Options = {
  clients: string;
  out: string;
  scenario?: string;
  suite?: string;
  json?: boolean;
  timeout: number;
  repeat: number;
  allowUnverified?: boolean;
  recorded?: boolean;
};
async function execute(options: Options): Promise<void> {
  if (!options.clients) throw new CanaryError('--clients is required for a native run');
  const list = await clients(options.clients);
  if (options.scenario && options.suite)
    throw new CanaryError('Choose either --scenario or --suite');
  if (options.suite && options.suite !== 'core')
    throw new CanaryError('Only suite core is supported');
  const scenarios = options.suite ? CORE : [scenarioSchema.parse(options.scenario ?? 'same-name')];
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });
  try {
    await stat(resolve(out, 'report.json'));
    throw new CanaryError('Output report exists; choose a fresh directory');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const signal = new AbortController();
  const abort = () => signal.abort();
  process.once('SIGINT', abort);
  const deadline = setTimeout(abort, 15 * 60 * 1000);
  const cases: CaseResult[] = [];
  try {
    for (const client of list) {
      for (const scenario of scenarios) {
        for (let repeat = 1; repeat <= options.repeat; repeat++) {
          if (signal.signal.aborted) break;
          process.stderr.write(
            `${plain(client.label)} · ${scenario} · repeat ${repeat}/${options.repeat}\n`,
          );
          cases.push(
            await runCase(
              client,
              scenario,
              repeat,
              resolve(out, 'runs'),
              options.timeout * 1000,
              signal.signal,
              !!options.allowUnverified,
            ),
          );
        }
        if (signal.signal.aborted) break;
      }
      if (signal.signal.aborted) break;
    }
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', abort);
  }
  let sourceCommit = 'uncommitted';
  try {
    sourceCommit = JSON.parse(
      await readFile(resolve(root, 'dist/build-meta.json'), 'utf8'),
    ).sourceCommit;
  } catch {
    /* A source checkout before its first build has no release provenance. */
  }
  const exitCode = signal.signal.aborted ? 130 : aggregateExit(cases.map((c) => c.exitCode));
  const osVersion =
    process.platform === 'darwin'
      ? execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
          encoding: 'utf8',
          timeout: 3000,
        }).trim()
      : release();
  const report: Report = {
    schemaVersion: 1,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    toolVersion: VERSION,
    sourceCommit,
    environment: {
      os: process.platform,
      arch: process.arch,
      osVersion,
      kernelVersion: release(),
      node: process.version,
      networkSandbox: false,
      paidInference: false,
    },
    clients: list.map((c) => ({
      label: c.label,
      nativeVersion: c.expectedVersion,
      expectedSha256: c.expectedSha256,
    })),
    negotiatedProtocol: PROTOCOL,
    adapterVersion: ADAPTER_VERSION,
    captureMode: 'loopback-synthetic-pre-inference',
    recorded: false,
    exitCode,
    cases,
    omissions: [
      'Reconnect not supported by adapter',
      'No model inference, Desktop, Cowork, hosted or global compatibility claim',
      'Isolated configuration is not a measured network air gap',
    ],
    reproduceCommands: [
      `mcpclientcanary run --clients ./clients.local.json ${options.suite ? '--suite core' : '--scenario ' + scenarios[0]} --repeat ${options.repeat} --timeout ${options.timeout} --out ./new-results`,
    ],
  };
  await writeReports(report, out);
  process.exitCode = exitCode;
  print(
    {
      exitCode,
      report: resolve(out, 'report.json'),
      html: resolve(out, 'report.html'),
      cases: cases.map((c) => ({
        client: c.client,
        scenario: c.scenario,
        repeat: c.repeat,
        harnessStatus: c.harnessStatus,
        clientContractStatus: c.clientContractStatus,
        exitCode: c.exitCode,
      })),
    },
    !!options.json,
    `Saved ${cases.length} native cases to ${out}\nExit ${exitCode}: ${exitCode === 1 ? 'measured client contract violation' : exitCode === 0 ? 'all selected contracts observed to pass' : 'incomplete or harness error; inspect report.json'}`,
  );
}
const program = new Command()
  .name('mcpclientcanary')
  .description('Reproduce native MCP client state regressions with evidence you can inspect.')
  .version(VERSION)
  .exitOverride();
program
  .command('doctor')
  .requiredOption('--clients <path>', 'local executable manifest')
  .option('--json', 'machine-readable output')
  .option('--allow-unverified', 'diagnostic only; never claim supported coverage')
  .option('--out <dir>', 'local doctor manifests', './doctor-results')
  .action(async (options) => {
    const list = await clients(options.clients);
    const manifest = [];
    let code = 0;
    for (const c of list) {
      const owned = await createOwned(resolve(options.out));
      try {
        const check = await verifyClient(c, owned, !!options.allowUnverified);
        manifest.push({ label: c.label, ...check.local, ...check.public });
        if (!check.public.verified) code = 3;
        await writeFile(
          resolve(owned.root, 'doctor.manifest.local.json'),
          JSON.stringify(
            { schemaVersion: 1, client: check.local, capabilities: check.public },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      } catch (e) {
        code = e instanceof CanaryError ? e.code : 2;
        manifest.push({
          label: c.label,
          error: e instanceof CanaryError ? e.message : 'Doctor validation/I/O error',
        });
      } finally {
        await cleanupOwned(owned);
      }
    }
    process.exitCode = code;
    print(
      { schemaVersion: 1, exitCode: code, clients: manifest },
      !!options.json,
      JSON.stringify(manifest, null, 2),
    );
  });
program
  .command('init')
  .requiredOption('--dir <path>', 'new example directory')
  .action(async (options) => {
    const dir = resolve(options.dir);
    await mkdir(dir, { recursive: false });
    const example = {
      schemaVersion: 1,
      clients: Object.entries(officialHashes).map(([version, hash]) => ({
        label: 'Claude Code ' + version,
        executable: '/absolute/path/to/owned/cache/' + version + '/claude',
        expectedVersion: version,
        expectedSha256: hash,
        os: 'darwin',
        arch: 'arm64',
      })),
    };
    await writeFile(resolve(dir, 'clients.example.json'), JSON.stringify(example, null, 2) + '\n');
    await writeFile(
      resolve(dir, 'README.md'),
      '# Local canary example\n\nDownload the two official native distributions into separate owned cache directories (see the package README). Replace both executable placeholders and save clients.local.json. Run doctor, then core. No native download or account login happens in init.\n',
    );
    await writeFile(
      resolve(dir, 'scenario.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'same-name',
          toolName: 'lookup_record',
          mutationKind: 'description-and-inputSchema',
          requiredStages: [
            'initial-deferred',
            'notification-trigger',
            'notification-current',
            'resume-continuity',
            'resume-current',
          ],
          observationWindowMs: 1000,
        },
        null,
        2,
      ),
    );
    process.stdout.write('Created ' + dir + '\n');
  });
function runOptions(command: Command) {
  return command
    .option('--clients <path>', 'local executable manifest; required for native runs')
    .requiredOption('--out <dir>', 'fresh output directory')
    .option('--scenario <id>', 'one synthetic scenario')
    .option('--suite <id>', 'core: six scenarios')
    .option('--repeat <count>', 'independent repeats (1..3)', bounded(1, 3), 2)
    .option('--timeout <seconds>', 'per phase (5..90)', bounded(5, 90), 30)
    .option('--json', 'clean JSON summary')
    .option('--no-open', 'never opens automatically; retained for scripting')
    .option('--allow-unverified', 'diagnostic only; verdict cannot pass');
}
runOptions(program.command('run')).action(execute);
runOptions(
  program
    .command('demo')
    .option('--recorded', 'render packaged dated measurement; current runtime is not checked'),
).action(async (options: Options) => {
  if (options.recorded) {
    const r = await loadReport(resolve(root, 'examples/recorded-report.json'));
    r.recorded = true;
    await writeReports(r, options.out);
    print(
      {
        recorded: true,
        currentRuntimeTested: false,
        timestamp: r.timestamp,
        versions: r.clients,
        out: resolve(options.out),
      },
      !!options.json,
      'Rendered recorded synthetic measurement. Current native runtime was not tested.',
    );
  } else
    await execute({
      ...options,
      scenario: options.scenario ?? 'same-name',
      repeat: options.repeat ?? 2,
    });
});
program
  .command('report')
  .argument('<input>', 'safe report.json')
  .requiredOption('--out <path>', 'new report.html path')
  .option('--json', 'clean JSON summary')
  .option('--no-open', 'no automatic opening')
  .action(async (input, options) => {
    await writeHtml(await loadReport(input), options.out);
    print({ html: resolve(options.out) }, !!options.json, 'Saved ' + resolve(options.out));
  });
try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (
    e instanceof CommanderError &&
    ['commander.version', 'commander.helpDisplayed'].includes(e.code)
  ) {
    process.exitCode = 0;
  } else {
    process.exitCode = e instanceof CanaryError ? e.code : 2;
    process.stderr.write(
      (e instanceof CanaryError
        ? e.message
        : e instanceof CommanderError
          ? e.message
          : 'Invalid input, file or report schema') + '\n',
    );
  }
}
