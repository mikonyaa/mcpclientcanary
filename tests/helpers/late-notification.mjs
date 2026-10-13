// Controlled logic regression using actual compiled runCase; never native verification.
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as collector from '../../dist/evidence/collector.js';
import { original } from './report.mjs';
const r = await original(),
  c = r.cases.find((c) => c.scenario === 'no-change');
const initialEvents = c.evidence.filter((e) => e.producer === 'server');
const cutoff = initialEvents.findIndex((e) => e.event === 'notification-complete');
const server = structuredClone(initialEvents.slice(0, cutoff + 1));
let control,
  terminating = false;
const modelEvents = structuredClone(
  c.evidence.filter(
    (e) => e.producer === 'model' && (e.data.stage === 'initial' || e.event === 'endpoint-start'),
  ),
);
const nativeEvents = structuredClone(
  c.evidence.filter(
    (e) =>
      e.producer === 'native' &&
      (['spawn', 'init'].includes(e.event) || e.data.stage === 'initial'),
  ),
).slice(0, 4);
const pub = structuredClone(c.evidence.find((e) => e.event === 'isolation-verified').data);
delete pub.childEnvCanary;
class ObservedRecorder extends collector.Recorder {
  add(...args) {
    const e = super.add(...args);
    if (args[0] === 'case-error') terminating = true;
    return e;
  }
}
class MockLoopback {
  constructor() {
    this.recorder = { events: modelEvents };
    this.url = 'controlled-test';
  }
  async start() {}
  async close() {}
  getCapture(stage) {
    return this.recorder.events.findLast((e) => e.event === 'request' && e.data.stage === stage)
      ?.data;
  }
}
class MockDriver {
  constructor() {
    this.recorder = { events: nativeEvents };
    this.sessionId = c.continuity.initialSessionId;
  }
  start() {}
  async turn() {}
  async close() {}
}
const mocks = {
  'node:fs/promises': { writeFile: async () => {} },
  '../native/isolation.js': {
    createOwned: async () => ({
      runId: c.id,
      root: '/controlled-test',
      control: 'control',
      serverEvidence: 'events',
      project: 'project',
      config: 'config',
      nonce: 'nonce',
    }),
    cleanupOwned: async () => {},
    childSettings: {},
  },
  '../adapters/claude-code/index.js': {
    verifyClient: async () => ({ public: pub, executable: 'test-double' }),
  },
  '../native/driver.js': { NativeDriver: MockDriver },
  '../model/loopback.js': { Loopback: MockLoopback },
  '../server/phase-control.js': {
    writeControl: async (_r, _p, value) => {
      control = value;
    },
  },
  '../evidence/collector.js': {
    ...collector,
    Recorder: ObservedRecorder,
    readEvents: () => {
      const ev = structuredClone(
        terminating
          ? server
          : server.slice(
              0,
              server.findIndex((e) => e.event === 'phase-applied'),
            ),
      );
      const ack = ev.find((e) => e.event === 'stream-checkpoint');
      ack.data.barrierToken = control.barrierToken;
      ack.digest = collector.digest(ack.data);
      return ev;
    },
  },
};
const source = new URL('../../dist/scenarios/state-machine.js', import.meta.url);
const m = new SourceTextModule(await readFile(source, 'utf8'), {
  identifier: source.href,
  initializeImportMeta(meta) {
    meta.url = source.href;
  },
});
await m.link(async (name) => {
  const exports =
    mocks[name] ?? (await import(new URL(name, source).href).catch(() => import(name)));
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
  });
});
await m.evaluate();
const partial = await m.namespace.runCase(
  { label: c.client, expectedVersion: c.nativeVersion },
  'no-change',
  1,
  'controlled-test',
  20,
);
r.cases = [partial];
r.exitCode = partial.exitCode;
process.stdout.write(JSON.stringify(r) + '\n');
