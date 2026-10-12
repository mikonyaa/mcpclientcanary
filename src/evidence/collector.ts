import { createHash, randomUUID } from 'node:crypto';
import { openSync, writeSync, closeSync, readFileSync, statSync, constants } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { type Evidence, type Data, eventSchema, MAX_BYTES, CanaryError } from '../types.js';
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
export const digest = (x: unknown) => createHash('sha256').update(canonical(x)).digest('hex');
export class Recorder {
  readonly events: Evidence[] = [];
  readonly instance = randomUUID();
  private seq = 0;
  private start = performance.now();
  private bytes = 0;
  pidOverride: number | undefined;
  constructor(
    readonly producer: Evidence['producer'],
    readonly file?: string,
  ) {}
  add(
    event: string,
    data: Data = {},
    phase = 'A',
    generation = 1,
    direction: Evidence['direction'] = 'local',
  ): Evidence {
    const e: Evidence = {
      ref: `${this.producer}:${this.instance}:${this.seq + 1}`,
      producer: this.producer,
      instance: this.instance,
      pid: this.pidOverride ?? process.pid,
      seq: this.seq + 1,
      elapsedMs: Math.round((performance.now() - this.start) * 1000) / 1000,
      phase,
      generation,
      direction,
      event,
      data,
      digest: digest(data),
    };
    const line = JSON.stringify(e) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.bytes + bytes > MAX_BYTES) throw new CanaryError('Evidence exceeded 16 MiB');
    if (this.file) {
      const fd = openSync(
        this.file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    }
    this.bytes += bytes;
    this.seq++;
    this.events.push(e);
    return e;
  }
}
export function readEvents(file: string, missingOkay = false): Evidence[] {
  try {
    if (statSync(file).size > MAX_BYTES) throw new CanaryError('Evidence input exceeded 16 MiB');
    const text = readFileSync(file, 'utf8');
    if (text && !text.endsWith('\n')) throw new CanaryError('Truncated evidence stream');
    const events = text.trim()
      ? text
          .trim()
          .split('\n')
          .map((l) => eventSchema.parse(JSON.parse(l)))
      : [];
    validateEvents(events);
    return events;
  } catch (e) {
    if (missingOkay && (e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}
export function validateEvents(events: Evidence[]): void {
  const seq = new Map<string, number>();
  const refs = new Set<string>();
  for (const e of events) {
    const key = e.producer + e.instance;
    if (e.seq !== (seq.get(key) ?? 0) + 1)
      throw new CanaryError('Missing or reordered evidence event');
    if (digest(e.data) !== e.digest || refs.has(e.ref))
      throw new CanaryError('Evidence digest mismatch or duplicate reference');
    seq.set(key, e.seq);
    refs.add(e.ref);
  }
}
