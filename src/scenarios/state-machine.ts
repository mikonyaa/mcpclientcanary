import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createOwned, cleanupOwned, childSettings } from '../native/isolation.js';
import { verifyClient } from '../adapters/claude-code/index.js';
import { NativeDriver } from '../native/driver.js';
import { Loopback } from '../model/loopback.js';
import { definitions } from '../server/definitions.js';
import { writeControl } from '../server/phase-control.js';
import { Recorder, readEvents, digest, validateEvents } from '../evidence/collector.js';
import { resolveDefinition } from '../evidence/resolve.js';
import { stage, resolutionStage, verdict } from '../verdict/contracts.js';
import {
  type ClientConfig,
  type CaseResult,
  type Scenario,
  type Evidence,
  type Stage,
  type Control,
  type Resolution,
  CanaryError,
  obj,
  arr,
  PROTOCOL,
} from '../types.js';
export const WINDOW_MS = 1000;
export const continuity = (
  initial: unknown,
  resumed: unknown,
  noncePresent: unknown,
  nonceReintroduced = false,
) =>
  typeof initial === 'string' && initial === resumed && noncePresent === true && !nonceReintroduced;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function runCase(
  client: ClientConfig,
  scenario: Scenario,
  repeat: number,
  parent: string,
  timeoutMs: number,
  signal?: AbortSignal,
  allowUnverified = false,
): Promise<CaseResult> {
  const owned = await createOwned(parent),
    harness = new Recorder('harness'),
    model = new Loopback(owned.nonce);
  let driver: NativeDriver | undefined;
  let verified = false;
  let provenance: Record<string, unknown> = {};
  const errors: string[] = [];
  let caughtCode: number | undefined;
  let firstSession: string | undefined, resumedSession: string | undefined;
  let processSaved = false;
  let triggerRef: string | undefined;
  let server: Evidence[] = [];
  const started = performance.now();
  const stages: Stage[] = [];
  const firstPhase = scenario === 'fresh-b' ? 'B' : 'A';
  const nextPhase = scenario === 'no-change' ? 'A' : 'B';
  const initialControl: Control = {
    schemaVersion: 1,
    runId: owned.runId,
    scenario,
    phase: firstPhase,
    generation: 1,
  };
  let currentControl = initialControl;
  const checkpoints: string[] = [];
  async function checkpoint(name: string) {
    const token = randomUUID();
    currentControl = { ...currentControl, barrierToken: token };
    await writeControl(owned.root, owned.control, currentControl);
    const start = performance.now();
    while (performance.now() - start < 3000) {
      const events = readEvents(owned.serverEvidence, true);
      const ack = events.find(
        (e) => e.event === 'stream-checkpoint' && e.data.barrierToken === token,
      );
      if (ack) {
        checkpoints.push(ack.ref);
        harness.add('observation-checkpoint', {
          stage: name,
          serverCheckpointRef: ack.ref,
          barrierToken: token,
        });
        return;
      }
      await pause(30);
    }
    throw new CanaryError('Server recorder checkpoint missing; observation incomplete', 3);
  }
  let notificationWindowElapsedMs = 0;
  try {
    const check = await verifyClient(client, owned, allowUnverified);
    verified = check.public.verified;
    provenance = {
      ...check.public,
      environmentSettings: childSettings,
      experimentalBetasDisabled: false,
      privateRawCapture: false,
      realCredentialReuse: false,
    };
    const isolated = harness.add('isolation-verified', {
      ...check.public,
      childEnvCanary: 'parent ANTHROPIC_API_KEY/OAUTH/proxy/NODE_OPTIONS excluded by allowlist',
    });
    stages.push(
      stage(
        'isolation',
        'observed-pass',
        'Independent config, project and credential namespace; clean native auth status',
        [isolated.ref],
      ),
    );
    await writeControl(owned.root, owned.control, initialControl);
    const mcp = resolve(owned.root, 'mcp.json');
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../server/fixture-server.js');
    await writeFile(
      mcp,
      JSON.stringify({
        mcpServers: {
          canary: {
            command: process.execPath,
            args: [fixture, owned.root, owned.control, owned.serverEvidence],
          },
        },
      }),
      { mode: 0o600 },
    );
    model.phase = firstPhase;
    await model.start();
    driver = new NativeDriver(check.executable, owned, model, timeoutMs, signal);
    driver.start(mcp);
    harness.add('user-turn', { stage: 'initial', syntheticNonceIntroduced: true }, firstPhase, 1);
    await driver.turn(`Synthetic canary. Remember ${owned.nonce}. Search the lookup_record tool.`);
    firstSession = driver.sessionId;
    await checkpoint('initial');
    const next: Control = { ...currentControl, phase: nextPhase, generation: 2 };
    currentControl = next;
    const controlEvent = harness.add(
      'control-write',
      { from: firstPhase, to: nextPhase, generation: 2 },
      nextPhase,
      2,
    );
    await writeControl(owned.root, owned.control, next);
    const waitStart = performance.now();
    while (performance.now() - waitStart < Math.min(timeoutMs, 5000)) {
      server = readEvents(owned.serverEvidence, true);
      const notification = server.find((e) => e.event === 'notification-complete');
      if (notification) {
        triggerRef = notification.ref;
        break;
      }
      if (signal?.aborted) throw new CanaryError('Cancelled', 130);
      await pause(30);
    }
    if (!triggerRef)
      throw new CanaryError(
        'Server did not confirm notification send; lifecycle trigger unobserved',
        3,
      );
    await pause(WINDOW_MS);
    notificationWindowElapsedMs = performance.now() - waitStart;
    harness.add(
      'notification-window-complete',
      { controlRef: controlEvent.ref, notificationRef: triggerRef, windowMs: WINDOW_MS },
      nextPhase,
      2,
    );
    model.stage = 'notification';
    model.phase = nextPhase;
    model.generation = 2;
    if (scenario === 'added-tool') model.target = 'lookup_summary';
    harness.add(
      'user-turn',
      { stage: 'notification', syntheticNonceIntroduced: false, expectedDefinitionIncluded: false },
      nextPhase,
      2,
    );
    await driver.turn('Search the synthetic lookup tool again.');
    await checkpoint('notification');
    await driver.close();
    processSaved = true;
    harness.add('save-barrier', { nativeSessionId: firstSession, nativeExitCode: 0 }, nextPhase, 2);
    if (!firstSession) throw new CanaryError('No initial native session ID', 3);
    model.stage = 'resume';
    driver.start(mcp, firstSession);
    harness.add(
      'user-turn',
      { stage: 'resume', syntheticNonceIntroduced: false, expectedDefinitionIncluded: false },
      nextPhase,
      2,
    );
    await driver.turn('Continue this synthetic conversation and search the lookup tool again.');
    resumedSession = driver.sessionId;
    await checkpoint('resume');
    await driver.close();
  } catch (e) {
    caughtCode = e instanceof CanaryError ? e.code : 2;
    if (caughtCode === 2)
      errors.push(
        e instanceof CanaryError ? e.message : 'Harness file, launch or validation error',
      );
    harness.add('case-error', {
      code: caughtCode,
      reason: e instanceof CanaryError ? e.message : 'Harness I/O or validation error',
    });
  } finally {
    try {
      await driver?.close(false);
    } catch {
      errors.push('Owned native process cleanup failed');
    }
    try {
      if (model.url) await model.close();
    } catch {
      errors.push('Owned loopback endpoint cleanup failed');
    }
    await pause(50);
    try {
      server = readEvents(owned.serverEvidence, true);
    } catch {
      errors.push('Server evidence stream corrupt or incomplete');
    }
    try {
      await cleanupOwned(owned);
      harness.add('cleanup-complete', { privateConfigAndSessionRemoved: true });
    } catch {
      errors.push('Owned config/session cleanup failed');
    }
  }
  const events = [
    ...harness.events,
    ...server,
    ...model.recorder.events,
    ...(driver?.recorder.events ?? []),
  ];
  try {
    validateEvents(events);
  } catch {
    errors.push('Evidence validation failed');
  }
  const initialExpected = definitions(initialControl)[0]!;
  const expectedTools = definitions({ ...initialControl, phase: nextPhase });
  const target = scenario === 'added-tool' ? 'lookup_summary' : 'lookup_record';
  const expected = expectedTools.find((t) => t.name === target)!;
  const resolutions: Record<string, Resolution> = {
    initial: resolveDefinition(events, 'initial', 'mcp__canary__lookup_record', initialExpected),
    notification: resolveDefinition(events, 'notification', 'mcp__canary__' + target, expected),
    resume: resolveDefinition(events, 'resume', 'mcp__canary__' + target, expected),
  };
  const sentLists = server.filter((e) => e.event === 'sent' && e.data.method === 'tools/list');
  const firstList = sentLists.find((e) => e.phase === firstPhase && e.generation === 1);
  const initInstances = server.filter((e) => e.event === 'server-start');
  const initialInstance = initInstances[0]?.instance,
    resumeInstance = initInstances[1]?.instance;
  const liveList = sentLists.find((e) => e.generation === 2 && e.instance === initialInstance);
  const resumedList = sentLists.find((e) => e.instance === resumeInstance);
  function wire(
    id: string,
    e: Evidence | undefined,
    defs: ReturnType<typeof definitions>,
    negativeMeasured = false,
  ) {
    const match =
      !!e &&
      defs.every((d) =>
        arr(e.data.tools)
          .map(obj)
          .some(
            (t) =>
              t.name === d.name &&
              digest(t.description) === digest(d.description) &&
              digest(t.inputSchema) === digest(d.inputSchema),
          ),
      );
    stages.push(
      stage(
        id,
        match ? 'observed-pass' : negativeMeasured ? 'observed-fail' : 'not-reached',
        match
          ? 'Correlated tools/list response sent to native client with expected description and inputSchema'
          : negativeMeasured
            ? `No matching live tools/list response in ${WINDOW_MS} ms observation window and completed next turn; current definition remains stale. This is a lifecycle contract, not an MCP specification verdict`
            : 'No matching wire response observed',
        e ? [e.ref] : [],
      ),
    );
  }
  wire('initial-wire', firstList, [initialExpected]);
  const loadedInitial = events.find(
    (e) => e.event === 'search-result-observed' && e.data.stage === 'initial',
  );
  const firstRequest = events.find(
    (e) => e.producer === 'model' && e.event === 'request' && e.data.stage === 'initial',
  );
  const currentInitial = obj(resolutions.initial?.current);
  const deferred =
    !!loadedInitial &&
    !!firstRequest &&
    firstRequest.data.toolSearchPresent === true &&
    currentInitial.defer_loading === true;
  stages.push(
    stage(
      'initial-deferred',
      deferred ? 'observed-pass' : 'not-supported',
      deferred
        ? 'Native ToolSearch executed and returned tool_reference; outbound target uses defer_loading:true'
        : 'Deferred loading not demonstrated',
      [loadedInitial?.ref, firstRequest?.ref].filter((r): r is string => !!r),
    ),
  );
  for (const name of ['initial', 'notification', 'resume']) {
    const result = events.find(
      (e) => e.event === 'search-result-observed' && e.data.stage === name,
    );
    stages.push(
      stage(
        name + '-search',
        result && result.data.isError !== true ? 'observed-pass' : 'not-reached',
        result
          ? 'Actual native tool_result matched the mock-issued tool_use_id'
          : 'No correlated ToolSearch result',
        result ? [result.ref] : [],
      ),
    );
  }
  stages.push(resolutionStage('initial-current', resolutions.initial!));
  stages.push(
    stage(
      'notification-trigger',
      triggerRef ? 'observed-pass' : 'not-reached',
      'Phase was applied on the same live server before list_changed send; send does not prove receipt',
      triggerRef ? [triggerRef] : [],
    ),
  );
  const liveSame = server.find(
    (e) => e.event === 'phase-applied' && e.instance === initialInstance,
  );
  stages.push(
    stage(
      'same-live-instance',
      liveSame ? 'observed-pass' : 'not-reached',
      'Initial and change generation use the same synthetic server process',
      liveSame ? [liveSame.ref] : [],
    ),
  );
  const measuredMissing =
    !!triggerRef &&
    processSaved &&
    continuity(firstSession, resumedSession, model.getCapture('resume')?.noncePresent) &&
    resolutions.notification?.status === 'resolved' &&
    (resolutions.notification.schemaStatus === 'stale' ||
      resolutions.notification.descriptionStatus === 'stale') &&
    checkpoints.length === 3;
  wire('notification-wire', liveList, expectedTools, measuredMissing);
  stages.push(resolutionStage('notification-current', resolutions.notification!));
  stages.push(
    stage(
      'process-save',
      processSaved ? 'observed-pass' : 'not-reached',
      'Native stdin closed; original CLI exited 0 before --resume',
      events.filter((e) => e.event === 'save-barrier').map((e) => e.ref),
    ),
  );
  wire('resume-wire', resumedList, expectedTools);
  const noncePresent = model.getCapture('resume')?.noncePresent;
  const continuous = processSaved && continuity(firstSession, resumedSession, noncePresent);
  stages.push(
    stage(
      'resume-continuity',
      continuous ? 'observed-pass' : 'not-reached',
      continuous
        ? 'Same native session ID and prior nonce in outbound history; resume prompt introduced neither nonce nor schema'
        : 'Native session continuity not demonstrated',
      events
        .filter(
          (e) =>
            (e.event === 'init' && e.data.resumeRequested) ||
            (e.event === 'request' && e.data.stage === 'resume'),
        )
        .map((e) => e.ref),
    ),
  );
  stages.push(resolutionStage('resume-current', resolutions.resume!));
  const streams =
    checkpoints.length === 3 &&
    events.filter(
      (e) => e.event === 'process-exit' && e.data.code === 0 && e.data.stdoutComplete === true,
    ).length === 2 &&
    !model.error;
  stages.push(
    stage(
      'streams-complete',
      streams ? 'observed-pass' : 'not-reached',
      'Three explicit server recorder checkpoints bound the observation windows; two native structured streams close completely; bounded Messages capture has no error. Native shutdown may kill the stdio server without EOF',
      events
        .filter((e) => ['stream-checkpoint', 'stream-end', 'process-exit'].includes(e.event))
        .map((e) => e.ref),
    ),
  );
  if (server.some((e) => ['server-error', 'protocol-error'].includes(e.event)))
    errors.push('Synthetic server reported an error');
  if (server.some((e) => e.data.negotiatedProtocol && e.data.negotiatedProtocol !== PROTOCOL))
    errors.push('Negotiated protocol differs from pinned revision');
  const outcome = verdict(stages, errors, verified);
  if (caughtCode === 3 && !errors.length) {
    outcome.exitCode = 3;
    outcome.harnessStatus = 'incomplete';
    outcome.clientContractStatus = 'unknown';
  }
  if (caughtCode === 130) {
    outcome.exitCode = 130;
    outcome.harnessStatus = 'cancelled';
    outcome.clientContractStatus = 'unknown';
  }
  return {
    id: owned.runId,
    client: client.label,
    nativeVersion: client.expectedVersion,
    repeat,
    scenario,
    fixtureHash: digest({ initial: initialExpected, next: expectedTools }),
    ...outcome,
    stages,
    definitions: resolutions,
    evidence: events,
    errors,
    omissions: [
      'No inference or behavioral understanding measured',
      'Reconnect unsupported by this adapter',
    ],
    continuity: {
      initialSessionId: firstSession ?? null,
      resumedSessionId: resumedSession ?? null,
      priorNoncePresent: noncePresent ?? false,
      nonceReintroduced: false,
      proved: continuous,
    },
    window: {
      predeclaredObservationMs: WINDOW_MS,
      actualNotificationWaitMs: Math.round(notificationWindowElapsedMs),
      completionBarrier: 'native next-turn result + successful process exit',
      totalCaseMs: Math.round(performance.now() - started),
    },
    provenance,
  };
}
