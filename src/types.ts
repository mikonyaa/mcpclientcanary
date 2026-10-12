import { z } from 'zod';
export const VERSION = '0.1.0';
export const ADAPTER_VERSION = '1';
export const PROTOCOL = '2025-11-25';
export const SUPPORTED = ['2.1.294', '2.1.296'] as const;
export const MAX_BYTES = 16 * 1024 * 1024;
export type Data = Record<string, unknown>;
export const obj = (x: unknown): Data =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Data) : {};
export const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
export const clientSchema = z.strictObject({
  label: z.string().min(1).max(100),
  executable: z.string().min(1).max(4096),
  expectedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  os: z.literal('darwin'),
  arch: z.literal('arm64'),
});
export const clientsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clients: z.array(clientSchema).min(1).max(2),
});
export type ClientConfig = z.infer<typeof clientSchema>;
export const scenarioSchema = z.enum([
  'same-name',
  'fresh-b',
  'no-change',
  'added-tool',
  'description-only',
  'schema-only',
]);
export type Scenario = z.infer<typeof scenarioSchema>;
export const CORE: Scenario[] = [
  'same-name',
  'fresh-b',
  'no-change',
  'added-tool',
  'description-only',
  'schema-only',
];
export const controlSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  scenario: scenarioSchema,
  phase: z.enum(['A', 'B']),
  generation: z.number().int().min(1).max(2),
  barrierToken: z.string().uuid().optional(),
});
export type Control = z.infer<typeof controlSchema>;
export type Definition = { name: string; description: string; inputSchema: Data };
export const eventSchema = z.strictObject({
  ref: z.string(),
  producer: z.enum(['server', 'model', 'native', 'harness']),
  instance: z.string(),
  pid: z.number().int(),
  seq: z.number().int().positive(),
  elapsedMs: z.number().nonnegative(),
  phase: z.string(),
  generation: z.number().int(),
  direction: z.enum(['in', 'out', 'local']),
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Evidence = z.infer<typeof eventSchema>;
export const stageSchema = z.strictObject({
  id: z.string(),
  status: z.enum(['observed-pass', 'observed-fail', 'not-supported', 'not-reached']),
  reason: z.string(),
  evidenceRefs: z.array(z.string()),
});
export type Stage = z.infer<typeof stageSchema>;
const resolutionSchema = z.strictObject({
  status: z.enum(['resolved', 'unknown', 'ambiguous']),
  reason: z.string(),
  descriptionStatus: z.enum(['current', 'stale', 'unknown']),
  schemaStatus: z.enum(['current', 'stale', 'unknown']),
  current: z.record(z.string(), z.unknown()).nullable(),
  historical: z.array(z.record(z.string(), z.unknown())),
  loaded: z.record(z.string(), z.unknown()).nullable(),
  evidenceRefs: z.array(z.string()),
});
export type Resolution = z.infer<typeof resolutionSchema>;
export const caseSchema = z.strictObject({
  id: z.string(),
  client: z.string(),
  nativeVersion: z.string(),
  repeat: z.number().int(),
  scenario: scenarioSchema,
  fixtureHash: z.string(),
  harnessStatus: z.enum(['complete', 'error', 'incomplete', 'cancelled']),
  clientContractStatus: z.enum(['observed-pass', 'observed-fail', 'unknown']),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(130)]),
  stages: z.array(stageSchema),
  definitions: z.record(z.string(), resolutionSchema),
  evidence: z.array(eventSchema),
  errors: z.array(z.string()),
  omissions: z.array(z.string()),
  continuity: z.record(z.string(), z.unknown()),
  window: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
});
export type CaseResult = z.infer<typeof caseSchema>;
export const reportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  timestamp: z.string(),
  toolVersion: z.string(),
  sourceCommit: z.string(),
  environment: z.record(z.string(), z.unknown()),
  clients: z.array(z.record(z.string(), z.unknown())),
  negotiatedProtocol: z.literal(PROTOCOL),
  adapterVersion: z.string(),
  captureMode: z.literal('loopback-synthetic-pre-inference'),
  recorded: z.boolean(),
  exitCode: z.number().int(),
  cases: z.array(caseSchema),
  omissions: z.array(z.string()),
  reproduceCommands: z.array(z.string()),
});
export type Report = z.infer<typeof reportSchema>;
export class CanaryError extends Error {
  constructor(
    message: string,
    public readonly code: 2 | 3 | 130 = 2,
  ) {
    super(message);
    this.name = 'CanaryError';
  }
}
