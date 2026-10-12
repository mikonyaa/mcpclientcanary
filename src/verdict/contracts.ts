import { type Stage, type CaseResult, type Resolution } from '../types.js';
export function stage(
  id: string,
  status: Stage['status'],
  reason: string,
  evidenceRefs: string[] = [],
): Stage {
  return { id, status, reason, evidenceRefs };
}
export function resolutionStage(id: string, r: Resolution): Stage {
  return stage(
    id,
    r.status !== 'resolved'
      ? 'not-supported'
      : r.descriptionStatus === 'stale' || r.schemaStatus === 'stale'
        ? 'observed-fail'
        : 'observed-pass',
    r.status !== 'resolved'
      ? r.reason
      : `description: ${r.descriptionStatus}; inputSchema: ${r.schemaStatus}. ${r.reason}`,
    r.evidenceRefs,
  );
}
export function aggregateExit(codes: number[]): number {
  if (codes.includes(130)) return 130;
  for (const code of [2, 3, 1]) if (codes.includes(code)) return code;
  return codes.length ? 0 : 3;
}
export function verdict(
  stages: Stage[],
  errors: string[],
  verified = true,
): Pick<CaseResult, 'harnessStatus' | 'clientContractStatus' | 'exitCode'> {
  if (errors.length)
    return { harnessStatus: 'error', clientContractStatus: 'unknown', exitCode: 2 };
  if (
    !verified ||
    !stages.length ||
    stages.some((s) => s.status === 'not-supported' || s.status === 'not-reached')
  )
    return { harnessStatus: 'incomplete', clientContractStatus: 'unknown', exitCode: 3 };
  const fail = stages.some((s) => s.status === 'observed-fail');
  return {
    harnessStatus: 'complete',
    clientContractStatus: fail ? 'observed-fail' : 'observed-pass',
    exitCode: fail ? 1 : 0,
  };
}
