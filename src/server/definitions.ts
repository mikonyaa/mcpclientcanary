import { z } from 'zod';
import { type Control, type Definition } from '../types.js';
import { digest } from '../evidence/collector.js';
export function definitions(c: Pick<Control, 'phase' | 'scenario'>): Definition[] {
  const changed = c.phase === 'B' && c.scenario !== 'no-change';
  const desc = changed && c.scenario !== 'schema-only' && c.scenario !== 'added-tool' ? 'B' : 'A';
  const schema =
    changed && c.scenario !== 'description-only' && c.scenario !== 'added-tool' ? 'B' : 'A';
  const tool: Definition = {
    name: 'lookup_record',
    description: `Look up an exclusively synthetic record. CANARY_SCHEMA_${desc}`,
    inputSchema: {
      type: 'object',
      properties: {
        recordId: { type: 'string' },
        ...(schema === 'B' ? { detail: { type: 'string', enum: ['summary', 'full'] } } : {}),
      },
      required: schema === 'B' ? ['recordId', 'detail'] : ['recordId'],
      additionalProperties: false,
    },
  };
  return c.scenario === 'added-tool' && changed
    ? [
        tool,
        {
          name: 'lookup_summary',
          description: 'Synthetic added tool. CANARY_ADDED_B',
          inputSchema: {
            type: 'object',
            properties: { recordId: { type: 'string' } },
            required: ['recordId'],
            additionalProperties: false,
          },
        },
      ]
    : [tool];
}
export function hashes(d: Definition) {
  return {
    descriptionHash: digest(d.description),
    schemaHash: digest(d.inputSchema),
    definitionHash: digest(d),
  };
}
export function validateArguments(d: Definition, args: unknown) {
  const full = (d.inputSchema.required as string[]).includes('detail');
  return (
    full
      ? z.strictObject({ recordId: z.string(), detail: z.enum(['summary', 'full']) })
      : z.strictObject({ recordId: z.string() })
  ).safeParse(args);
}
