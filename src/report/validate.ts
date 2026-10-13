import {
  reportSchema,
  CanaryError,
  PROTOCOL,
  obj,
  arr,
  type Report,
  type CaseResult,
  type Evidence,
  type Stage,
  type Definition,
} from '../types.js';
import { digest, validateEvents } from '../evidence/collector.js';
import { resolveDefinition } from '../evidence/resolve.js';
import { definitions, hashes } from '../server/definitions.js';
import { resolutionStage, verdict, aggregateExit } from '../verdict/contracts.js';
import { officialHashes } from '../adapters/claude-code/index.js';

const WINDOW_MS = 1000;
const phases = ['initial', 'notification', 'resume'] as const;
function requireIntegrity(ok: unknown, path: string, reason: string): asserts ok {
  if (!ok) throw new CanaryError(`Report integrity error at ${path}: ${reason}`);
}
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function unique(values: string[], path: string) {
  requireIntegrity(
    new Set(values).size === values.length,
    path,
    'duplicate identifiers/references',
  );
}

/** Validate schemaVersion 1 evidence without repairing or authenticating it. No I/O. */
export function validateReport(input: unknown): Report {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.join('.'))
      .join(', ');
    throw new CanaryError(`Invalid report schema at ${paths || 'root'}`);
  }
  const r = parsed.data;
  unique(
    r.cases.map((c) => c.id),
    'cases',
  );
  unique(
    r.cases.map((c) => JSON.stringify([c.client, c.scenario, c.repeat])),
    'cases',
  );
  unique(
    r.cases.flatMap((c) => c.evidence.map((e) => e.ref)),
    'cases.evidence',
  );
  const labels = r.clients.map((c) => c.label);
  requireIntegrity(
    labels.every((s) => typeof s === 'string'),
    'clients',
    'missing client label',
  );
  unique(labels as string[], 'clients');
  r.cases.forEach((c, i) => {
    const path = `cases[${i}]`;
    const client = r.clients.find((x) => x.label === c.client);
    requireIntegrity(
      client && client.nativeVersion === c.nativeVersion,
      path,
      'client/version not declared',
    );
    requireIntegrity(c.repeat >= 1 && c.repeat <= 3, path, 'repeat outside 1..3');
    validateCase(c, path);
    if (c.provenance.verified === true) {
      requireIntegrity(
        c.provenance.sha256 === client.expectedSha256 &&
          c.provenance.os === r.environment.os &&
          c.provenance.arch === r.environment.arch,
        path + '.provenance',
        'declared client/environment differs from isolation observation',
      );
    }
  });
  const expectedExit =
    r.environment.cancelled === true ? 130 : aggregateExit(r.cases.map((c) => c.exitCode));
  requireIntegrity(r.exitCode === expectedExit, 'exitCode', 'does not match aggregate outcome');
  return r;
}

function validateCase(c: CaseResult, path: string): void {
  try {
    validateEvents(c.evidence);
  } catch (e) {
    throw new CanaryError(
      `Report integrity error at ${path}.evidence: ${e instanceof CanaryError ? e.message : 'invalid event stream'}`,
    );
  }
  unique(
    c.stages.map((s) => s.id),
    path + '.stages',
  );
  const events = c.evidence;
  const lookup = new Map(events.map((e) => [e.ref, e]));
  const find = (producer: Evidence['producer'], event: string) =>
    events.filter((e) => e.producer === producer && e.event === event);
  for (const producer of ['harness', 'model', 'native'] as const) {
    requireIntegrity(
      new Set(events.filter((e) => e.producer === producer).map((e) => e.instance)).size <= 1,
      path + '.evidence',
      'adapter v1 requires one recorder instance per ' + producer + ' stream',
    );
  }
  function refs(values: string[], at: string) {
    unique(values, at);
    for (const ref of values) requireIntegrity(lookup.has(ref), at, 'dangling evidence reference');
  }
  const clocks = new Map<string, number>();
  for (const e of events) {
    const key = `${e.producer}:${e.instance}`;
    requireIntegrity(
      e.ref === `${key}:${e.seq}`,
      path + '.evidence',
      'reference does not identify producer/instance/sequence',
    );
    requireIntegrity(
      e.elapsedMs >= (clocks.get(key) ?? 0),
      path + '.evidence',
      'recorder clock moved backwards',
    );
    clocks.set(key, e.elapsedMs);
    for (const key of [
      'captureRef',
      'transitionRef',
      'serverCheckpointRef',
      'controlRef',
      'notificationRef',
    ])
      if (key in e.data)
        requireIntegrity(
          typeof e.data[key] === 'string' && lookup.has(String(e.data[key])),
          path + '.evidence',
          `invalid ${key}`,
        );
  }
  c.stages.forEach((s) => refs(s.evidenceRefs, path + '.stages.' + s.id));
  Object.values(c.definitions).forEach((d) => refs(d.evidenceRefs, path + '.definitions'));

  const initialPhase = c.scenario === 'fresh-b' ? 'B' : 'A';
  const nextPhase = c.scenario === 'no-change' ? 'A' : 'B';
  const first = definitions({ scenario: c.scenario, phase: initialPhase })[0]!;
  const next = definitions({ scenario: c.scenario, phase: nextPhase });
  requireIntegrity(
    c.fixtureHash === digest({ initial: first, next }),
    path + '.fixtureHash',
    'fixture does not match this scenario',
  );
  requireIntegrity(
    same(Object.keys(c.definitions).sort(), [...phases].sort()),
    path + '.definitions',
    'required resolution set missing or extended',
  );
  const resolutions = Object.fromEntries(
    phases.map((name) => {
      const short =
        name !== 'initial' && c.scenario === 'added-tool' ? 'lookup_summary' : 'lookup_record';
      const expected = name === 'initial' ? first : next.find((d) => d.name === short)!;
      const result = resolveDefinition(events, name, 'mcp__canary__' + short, expected);
      requireIntegrity(
        same(c.definitions[name], result),
        path + '.definitions.' + name,
        'summary differs from referenced outbound observation',
      );
      return [name, result];
    }),
  );

  const server = events.filter((e) => e.producer === 'server');
  const starts = find('server', 'server-start');
  for (const e of starts)
    requireIntegrity(e.data.runId === c.id, path + '.evidence', 'server belongs to another case');
  for (const e of server.filter((e) => e.event === 'sent' && 'requestId' in e.data)) {
    const request = server.find(
      (q) =>
        q.instance === e.instance &&
        q.seq < e.seq &&
        q.event === 'request' &&
        q.data.requestId === e.data.requestId &&
        q.data.method === e.data.method,
    );
    requireIntegrity(request, path + '.evidence', 'server response has no correlated request');
  }
  for (const e of server.filter((e) => e.event === 'sent' && e.data.method === 'tools/list')) {
    for (const t of arr(e.data.tools).map(obj)) {
      const def: Definition = {
        name: String(t.name),
        description: String(t.description),
        inputSchema: obj(t.inputSchema),
      };
      const h = hashes(def);
      requireIntegrity(
        Object.entries(h).every(([k, v]) => t[k] === v),
        path + '.evidence',
        'definition hashes differ from sent tools',
      );
    }
  }
  const checkpoints = find('harness', 'observation-checkpoint');
  unique(
    checkpoints.map((e) => String(e.data.stage)),
    path + '.checkpoints',
  );
  unique(
    checkpoints.map((e) => String(e.data.serverCheckpointRef)),
    path + '.checkpoints',
  );
  unique(
    checkpoints.map((e) => String(e.data.barrierToken)),
    path + '.checkpoints',
  );
  for (const e of checkpoints) {
    const ack = lookup.get(String(e.data.serverCheckpointRef));
    requireIntegrity(
      ack?.producer === 'server' &&
        ack.event === 'stream-checkpoint' &&
        ack.data.barrierToken === e.data.barrierToken,
      path + '.checkpoints',
      'checkpoint is not tied to its recorder acknowledgement',
    );
    requireIntegrity(
      phases.includes(e.data.stage as (typeof phases)[number]),
      path + '.checkpoints',
      'unknown checkpoint stage',
    );
    const initial = e.data.stage === 'initial',
      resumed = e.data.stage === 'resume';
    const start = starts[resumed ? 1 : 0];
    const turn = find('harness', 'user-turn').find((q) => q.data.stage === e.data.stage);
    requireIntegrity(
      ack &&
        start &&
        ack.instance === start.instance &&
        ack.phase === (initial ? initialPhase : nextPhase) &&
        ack.generation === (initial ? 1 : 2) &&
        turn &&
        turn.seq < e.seq,
      path + '.checkpoints',
      'checkpoint does not bound the corresponding turn/server generation',
    );
    if (!initial && !resumed) {
      const applied = server.find(
        (q) => q.event === 'phase-applied' && q.instance === start.instance,
      );
      requireIntegrity(
        applied && applied.seq < ack.seq,
        path + '.checkpoints',
        'notification checkpoint precedes its live transition',
      );
    }
  }
  for (const e of find('server', 'notification-complete')) {
    const applied = lookup.get(String(e.data.transitionRef));
    requireIntegrity(
      applied?.producer === 'server' &&
        applied.event === 'phase-applied' &&
        applied.instance === e.instance &&
        applied.seq < e.seq &&
        applied.generation === 2 &&
        e.generation === 2 &&
        applied.phase === nextPhase &&
        e.phase === nextPhase,
      path + '.notification',
      'notification is not tied to this live transition',
    );
    requireIntegrity(
      server.some(
        (q) =>
          q.instance === e.instance &&
          q.seq > applied.seq &&
          q.seq < e.seq &&
          q.event === 'sent' &&
          q.data.method === 'notifications/tools/list_changed',
      ),
      path + '.notification',
      'notification send missing',
    );
  }
  const requests = find('model', 'request');
  const searches = find('model', 'search-result-observed');
  const issues = find('model', 'search-issued');
  for (const e of [
    ...requests,
    ...searches,
    ...issues,
    ...find('native', 'loaded-result'),
    ...find('native', 'turn-complete'),
  ]) {
    requireIntegrity(
      phases.includes(e.data.stage as (typeof phases)[number]) &&
        e.phase === (e.data.stage === 'initial' ? initialPhase : nextPhase) &&
        e.generation === (e.data.stage === 'initial' ? 1 : 2),
      path + '.evidence',
      'observation phase/generation differs from lifecycle stage',
    );
  }
  unique(
    issues.map((e) => String(e.data.toolUseId)),
    path + '.search-issued',
  );
  for (const e of [...issues, ...searches]) {
    const capture = lookup.get(String(e.data.captureRef));
    requireIntegrity(
      capture?.producer === 'model' &&
        capture.event === 'request' &&
        capture.instance === e.instance &&
        capture.seq < e.seq &&
        capture.data.stage === e.data.stage &&
        capture.phase === e.phase &&
        capture.generation === e.generation,
      path + '.search',
      'search is not linked to the same outbound request',
    );
    if (e.event === 'search-result-observed') {
      const issue = issues.find(
        (q) =>
          q.data.stage === e.data.stage &&
          q.data.toolUseId === e.data.toolUseId &&
          q.seq < capture.seq,
      );
      const result = arr(capture.data.results)
        .map(obj)
        .find((q) => q.toolUseId === e.data.toolUseId);
      requireIntegrity(
        issue &&
          result &&
          ['isError', 'references', 'inlineDefinitions'].every((key) =>
            same(result[key], e.data[key]),
          ),
        path + '.search',
        'native result differs from issued ToolSearch/captured result',
      );
      const loaded = find('native', 'loaded-result').find(
        (q) => q.data.stage === e.data.stage && q.data.toolUseId === e.data.toolUseId,
      );
      requireIntegrity(
        loaded &&
          same(loaded.data.references, e.data.references) &&
          loaded.data.isError === e.data.isError,
        path + '.search',
        'native loaded-result linkage missing or inconsistent',
      );
    }
  }

  const isolation = find('harness', 'isolation-verified');
  requireIntegrity(isolation.length <= 1, path + '.isolation', 'duplicate isolation observations');
  if (isolation[0]) {
    for (const [key, value] of Object.entries(isolation[0].data))
      if (key !== 'childEnvCanary')
        requireIntegrity(
          same(c.provenance[key], value),
          path + '.provenance',
          'differs from isolation evidence',
        );
    if (c.provenance.verified === true)
      requireIntegrity(
        c.provenance.nativeVersion === c.nativeVersion &&
          c.provenance.sha256 === officialHashes[c.nativeVersion] &&
          c.provenance.authMethodBeforeDummy === 'none' &&
          c.provenance.configDirectoryConfirmed === true,
        path + '.provenance',
        'unsupported verified provenance',
      );
  } else
    requireIntegrity(
      Object.keys(c.provenance).length === 0,
      path + '.provenance',
      'verification without isolation evidence',
    );

  const native = find('native', 'init');
  const turns = find('native', 'turn-complete');
  function session(name: string): string | null {
    const turn = turns.find(
      (e) => e.data.stage === name && e.data.isError === false && e.data.subtype === 'success',
    );
    const init = turn
      ? native.findLast(
          (e) => e.instance === turn.instance && e.pid === turn.pid && e.seq < turn.seq,
        )
      : undefined;
    requireIntegrity(
      !turn || init || c.harnessStatus !== 'complete',
      path + '.continuity',
      'successful native turn has no matching process init',
    );
    if (turn && init)
      requireIntegrity(
        turn.data.sessionId === init.data.sessionId,
        path + '.continuity',
        'native turn session differs from init',
      );
    return typeof init?.data.sessionId === 'string' ? init.data.sessionId : null;
  }
  const initialSessionId = session('initial'),
    resumedSessionId = session('resume');
  const notificationSessionId = session('notification');
  if (notificationSessionId)
    requireIntegrity(
      notificationSessionId === initialSessionId,
      path + '.continuity',
      'notification turn changed the original native session',
    );
  const resumeRequest = requests.findLast((e) => e.data.stage === 'resume');
  const priorNoncePresent = resumeRequest?.data.noncePresent ?? false;
  const resumeTurn = find('harness', 'user-turn').find((e) => e.data.stage === 'resume');
  if (resumeTurn)
    requireIntegrity(
      resumeTurn.data.syntheticNonceIntroduced === false &&
        resumeTurn.data.expectedDefinitionIncluded === false,
      path + '.continuity',
      'resume prompt reintroduced expected evidence',
    );
  const saved = find('harness', 'save-barrier');
  const processSaved = saved.length === 1;
  const proved =
    processSaved &&
    typeof initialSessionId === 'string' &&
    initialSessionId === resumedSessionId &&
    priorNoncePresent === true;
  requireIntegrity(
    same(c.continuity, {
      initialSessionId,
      resumedSessionId,
      priorNoncePresent,
      nonceReintroduced: false,
      proved,
    }),
    path + '.continuity',
    'summary differs from session/nonce observations',
  );
  const spawns = find('native', 'spawn');
  if (saved[0]) {
    const exit = find('native', 'process-exit').find((e) => e.seq < (spawns[1]?.seq ?? Infinity));
    requireIntegrity(
      saved[0].data.nativeSessionId === initialSessionId &&
        saved[0].data.nativeExitCode === 0 &&
        exit?.data.code === 0 &&
        exit.data.stdoutComplete === true,
      path + '.continuity',
      'save barrier has no successful original process exit',
    );
  }
  if (spawns[1]) {
    const resumed = native.find((e) => e.seq > spawns[1]!.seq);
    requireIntegrity(
      processSaved &&
        spawns[1].data.resumeRequested === initialSessionId &&
        (!resumed || resumed.data.resumeRequested === initialSessionId),
      path + '.continuity',
      'resume does not link to saved native session',
    );
  }

  const windows = find('harness', 'notification-window-complete');
  requireIntegrity(windows.length <= 1, path + '.window', 'duplicate observation window');
  const window = windows[0];
  const downstream = events.some(
    (e) =>
      (e.producer === 'harness' &&
        ((e.event === 'user-turn' && ['notification', 'resume'].includes(String(e.data.stage))) ||
          e.event === 'save-barrier')) ||
      ((e.producer === 'model' || e.producer === 'native') &&
        ['notification', 'resume'].includes(String(e.data.stage))),
  );
  requireIntegrity(
    !downstream || window,
    path + '.window',
    'downstream observations require a completed bounded window',
  );
  requireIntegrity(
    c.window.predeclaredObservationMs === WINDOW_MS &&
      typeof c.window.totalCaseMs === 'number' &&
      c.window.totalCaseMs >= 0 &&
      typeof c.window.actualNotificationWaitMs === 'number',
    path + '.window',
    'invalid bounded window summary',
  );
  if (window) {
    const control = lookup.get(String(window.data.controlRef)),
      notification = lookup.get(String(window.data.notificationRef));
    requireIntegrity(
      control?.producer === 'harness' &&
        control.event === 'control-write' &&
        control.seq < window.seq &&
        control.data.from === initialPhase &&
        control.data.to === nextPhase &&
        notification?.producer === 'server' &&
        notification.event === 'notification-complete' &&
        window.data.windowMs === WINDOW_MS &&
        window.elapsedMs - control.elapsedMs >= WINDOW_MS &&
        Number(c.window.actualNotificationWaitMs) >= WINDOW_MS &&
        Number(c.window.totalCaseMs) >= Number(c.window.actualNotificationWaitMs),
      path + '.window',
      'window/trigger/control linkage inconsistent',
    );
    const turn = find('harness', 'user-turn').find((e) => e.data.stage === 'notification');
    if (turn)
      requireIntegrity(
        turn.seq > window.seq &&
          turn.data.syntheticNonceIntroduced === false &&
          turn.data.expectedDefinitionIncluded === false,
        path + '.window',
        'next turn did not follow the observation window',
      );
  } else
    requireIntegrity(
      c.window.actualNotificationWaitMs === 0,
      path + '.window',
      'wait summary without a completed window',
    );

  const expectedStages: Pick<Stage, 'id' | 'status' | 'evidenceRefs'>[] = [];
  function add(id: string, status: Stage['status'], evidenceRefs: string[] = []) {
    expectedStages.push({ id, status, evidenceRefs });
  }
  if (isolation[0]) add('isolation', 'observed-pass', [isolation[0].ref]);
  const sent = server.filter((e) => e.event === 'sent' && e.data.method === 'tools/list');
  function wire(id: string, e: Evidence | undefined, defs: Definition[], negative = false) {
    const match =
      !!e &&
      defs.every((d) =>
        arr(e.data.tools)
          .map(obj)
          .some(
            (t) =>
              t.name === d.name &&
              same(t.description, d.description) &&
              same(t.inputSchema, d.inputSchema),
          ),
      );
    add(id, match ? 'observed-pass' : negative ? 'observed-fail' : 'not-reached', e ? [e.ref] : []);
  }
  wire(
    'initial-wire',
    sent.find((e) => e.phase === initialPhase && e.generation === 1),
    [first],
  );
  const loadedInitial = searches.find((e) => e.data.stage === 'initial');
  const firstRequest = requests.find((e) => e.data.stage === 'initial');
  add(
    'initial-deferred',
    loadedInitial &&
      firstRequest?.data.toolSearchPresent === true &&
      obj(resolutions.initial!.current).defer_loading === true
      ? 'observed-pass'
      : 'not-supported',
    [loadedInitial?.ref, firstRequest?.ref].filter((s): s is string => !!s),
  );
  for (const name of phases) {
    const result = searches.find((e) => e.data.stage === name);
    add(
      name + '-search',
      result && result.data.isError !== true ? 'observed-pass' : 'not-reached',
      result ? [result.ref] : [],
    );
  }
  expectedStages.push(resolutionStage('initial-current', resolutions.initial!));
  // A finally-collected late send is diagnostic evidence, not an in-window trigger.
  const trigger = window ? lookup.get(String(window.data.notificationRef)) : undefined;
  add(
    'notification-trigger',
    trigger ? 'observed-pass' : 'not-reached',
    trigger ? [trigger.ref] : [],
  );
  const live = server.find(
    (e) => e.event === 'phase-applied' && e.instance === starts[0]?.instance,
  );
  add('same-live-instance', live ? 'observed-pass' : 'not-reached', live ? [live.ref] : []);
  const stale =
    resolutions.notification!.status === 'resolved' &&
    [resolutions.notification!.descriptionStatus, resolutions.notification!.schemaStatus].includes(
      'stale',
    );
  wire(
    'notification-wire',
    sent.find((e) => e.generation === 2 && e.instance === starts[0]?.instance),
    next,
    !!trigger && processSaved && proved && stale && checkpoints.length === 3,
  );
  expectedStages.push(resolutionStage('notification-current', resolutions.notification!));
  add(
    'process-save',
    processSaved ? 'observed-pass' : 'not-reached',
    saved.map((e) => e.ref),
  );
  wire(
    'resume-wire',
    sent.find((e) => e.instance === starts[1]?.instance),
    next,
  );
  add(
    'resume-continuity',
    proved ? 'observed-pass' : 'not-reached',
    events
      .filter(
        (e) =>
          (e.event === 'init' && e.data.resumeRequested) ||
          (e.event === 'request' && e.data.stage === 'resume'),
      )
      .map((e) => e.ref),
  );
  expectedStages.push(resolutionStage('resume-current', resolutions.resume!));
  const streams =
    checkpoints.length === 3 &&
    find('native', 'process-exit').filter(
      (e) => e.data.code === 0 && e.data.stdoutComplete === true,
    ).length === 2 &&
    !find('model', 'model-error').length;
  add(
    'streams-complete',
    streams ? 'observed-pass' : 'not-reached',
    events
      .filter((e) => ['stream-checkpoint', 'stream-end', 'process-exit'].includes(e.event))
      .map((e) => e.ref),
  );
  requireIntegrity(
    c.stages.length === expectedStages.length,
    path + '.stages',
    'missing or extra required stages',
  );
  for (const s of expectedStages) {
    const actual = c.stages.find((a) => a.id === s.id);
    requireIntegrity(
      actual && actual.status === s.status && same(actual.evidenceRefs, s.evidenceRefs),
      path + '.stages.' + s.id,
      'status/references differ from measured observations',
    );
  }
  const caught = find('harness', 'case-error');
  requireIntegrity(caught.length <= 1, path + '.errors', 'duplicate case termination');
  if (
    caught[0]?.data.code === 2 ||
    server.some((e) => ['server-error', 'protocol-error'].includes(e.event)) ||
    server.some((e) => e.data.negotiatedProtocol && e.data.negotiatedProtocol !== PROTOCOL)
  )
    requireIntegrity(c.errors.length, path + '.errors', 'harness error was omitted');
  const outcome = verdict(c.stages, c.errors, c.provenance.verified === true);
  if (caught[0]?.data.code === 3 && !c.errors.length)
    Object.assign(outcome, {
      harnessStatus: 'incomplete',
      clientContractStatus: 'unknown',
      exitCode: 3,
    });
  if (caught[0]?.data.code === 130)
    Object.assign(outcome, {
      harnessStatus: 'cancelled',
      clientContractStatus: 'unknown',
      exitCode: 130,
    });
  requireIntegrity(
    same(outcome, {
      harnessStatus: c.harnessStatus,
      clientContractStatus: c.clientContractStatus,
      exitCode: c.exitCode,
    }),
    path + '.outcome',
    'does not match verdict reducer',
  );
}
