import { type Definition, type Resolution, type Evidence, obj, arr } from '../types.js';
import { digest } from './collector.js';
export function resolveDefinition(
  events: Evidence[],
  stage: string,
  targetName: string,
  expected: Definition,
): Resolution {
  const requests = events.filter((e) => e.producer === 'model' && e.event === 'request');
  const currentCapture = requests.findLast((e) => e.data.stage === stage);
  const search = events.findLast(
    (e) => e.producer === 'model' && e.event === 'search-result-observed' && e.data.stage === stage,
  );
  const historical = requests
    .filter((e) => currentCapture && e.seq < currentCapture.seq && e.data.stage !== stage)
    .flatMap((e) =>
      arr(e.data.tools)
        .map(obj)
        .filter((t) => t.name === targetName),
    )
    .filter((v, i, a) => a.findIndex((x) => digest(x) === digest(v)) === i);
  const blank: Resolution = {
    status: 'unknown',
    reason: 'No matching native ToolSearch result and outbound definition',
    descriptionStatus: 'unknown',
    schemaStatus: 'unknown',
    current: null,
    historical,
    loaded: null,
    evidenceRefs: [currentCapture?.ref, search?.ref].filter((x): x is string => !!x),
  };
  if (!currentCapture || !search || search.data.isError === true) return blank;
  if (search.data.captureRef !== currentCapture.ref) {
    blank.reason = 'Loaded result is not tied to this current outbound capture';
    return blank;
  }
  const refs = arr(search.data.references).map(obj);
  const inline = arr(search.data.inlineDefinitions).map(obj);
  const defs = arr(currentCapture.data.tools)
    .map(obj)
    .filter((t) => t.name === targetName);
  if (
    refs.length !== 1 ||
    refs[0]?.tool_name !== targetName ||
    defs.length !== 1 ||
    inline.length > 1
  ) {
    blank.status = refs.length > 1 || defs.length > 1 ? 'ambiguous' : 'unknown';
    blank.reason =
      'Tool reference is missing, ambiguous or has no unique current outbound definition';
    return blank;
  }
  const current = defs[0];
  if (
    !current ||
    typeof current.description !== 'string' ||
    !Object.keys(obj(current.inputSchema)).length
  )
    return blank;
  if (inline.length === 1 && digest(inline[0]) !== digest(current)) {
    blank.status = 'ambiguous';
    blank.reason = 'Inline loaded definition disagrees with current reference resolution';
    return blank;
  }
  const descriptionStatus =
    digest(current.description) === digest(expected.description) ? 'current' : 'stale';
  const schemaStatus =
    digest(current.inputSchema) === digest(expected.inputSchema) ? 'current' : 'stale';
  return {
    ...blank,
    status: 'resolved',
    reason:
      'Native tool_result tool_reference resolves uniquely through the same outbound request tools array; pre-inference only',
    descriptionStatus,
    schemaStatus,
    current,
    loaded: {
      kind: 'tool_reference',
      toolUseId: search.data.toolUseId,
      tool_name: targetName,
      resolvedThrough: currentCapture.ref,
      definitionHash: digest({
        description: current.description,
        inputSchema: current.inputSchema,
      }),
    },
  };
}
