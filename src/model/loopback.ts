import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Recorder, digest } from '../evidence/collector.js';
import { CanaryError, MAX_BYTES, obj, arr, type Data } from '../types.js';
import {
  requestProjection,
  searchInvocation,
  messagesResponse,
  type MockBlock,
} from './protocol.js';
export class Loopback {
  readonly recorder = new Recorder('model');
  readonly ids = new Set<string>();
  stage = 'initial';
  phase = 'A';
  generation = 1;
  target = 'lookup_record';
  private bytes = 0;
  private turns = 0;
  private counter = 0;
  private issued = new Map<string, string>();
  error: CanaryError | undefined;
  url = '';
  constructor(readonly nonce: string) {}
  readonly server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
        this.bytes += Buffer.byteLength(chunk);
        if (this.bytes > MAX_BYTES) throw new CanaryError('Total model capture exceeded 16 MiB');
      }
      const data = Buffer.concat(chunks).toString('utf8');
      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":100}');
        return;
      }
      if (path !== '/v1/messages') {
        this.recorder.add(
          'unexpected-endpoint',
          { pathDigest: digest(path) },
          this.phase,
          this.generation,
          'in',
        );
        throw new CanaryError('Unexpected loopback endpoint');
      }
      if (req.headers.authorization !== 'Bearer mcpclientcanary-synthetic-loopback-only')
        throw new CanaryError('Unexpected loopback authorization; credential isolation failed');
      if (++this.turns > 12) throw new CanaryError('Model turn limit exceeded');
      const body = obj(JSON.parse(data));
      if (!Array.isArray(body.messages) || !Array.isArray(body.tools))
        throw new CanaryError('Malformed native Messages request');
      const projection = requestProjection(body, this.ids, this.nonce);
      const id = this.issued.get(this.stage);
      const matched = arr(projection.results)
        .map(obj)
        .find((r) => r.toolUseId === id);
      const capture = this.recorder.add(
        'request',
        {
          stage: this.stage,
          requestId: ++this.counter,
          syntheticCredentialValidated: true,
          ...projection,
        },
        this.phase,
        this.generation,
        'in',
      );
      let blocks: MockBlock[];
      if (matched) {
        blocks = [{ type: 'text', text: 'CANARY_STAGE_DONE_' + this.stage }];
        this.recorder.add(
          'search-result-observed',
          {
            stage: this.stage,
            toolUseId: id,
            captureRef: capture.ref,
            targetName: 'mcp__canary__' + this.target,
            ...matched,
          },
          this.phase,
          this.generation,
          'in',
        );
      } else {
        if (id) throw new CanaryError('Native tool_result missing for issued ToolSearch', 3);
        const invocation = searchInvocation(body, this.target);
        const useId = 'toolu_canary_' + randomUUID().replaceAll('-', '');
        this.issued.set(this.stage, useId);
        this.ids.add(useId);
        blocks = [{ type: 'tool_use', id: useId, name: invocation.name, input: invocation.input }];
        this.recorder.add(
          'search-issued',
          {
            stage: this.stage,
            toolUseId: useId,
            targetName: invocation.targetName,
            query: invocation.input.query,
            captureRef: capture.ref,
          },
          this.phase,
          this.generation,
          'out',
        );
      }
      messagesResponse(res, body, blocks, this.counter);
    })().catch((e) => {
      this.error =
        e instanceof CanaryError ? e : new CanaryError('Loopback JSON/I/O/protocol error');
      try {
        this.recorder.add(
          'model-error',
          { reason: this.error.message },
          this.phase,
          this.generation,
          'local',
        );
      } catch {
        /* The case records the error even when this bounded stream is full. */
      }
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        '{"type":"error","error":{"type":"invalid_request_error","message":"Synthetic harness error"}}',
      );
    });
  });
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.url = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    this.recorder.add('endpoint-start', { host: '127.0.0.1', fallback: false });
    return this.url;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
    this.recorder.add('stream-end', { totalBytesObserved: this.bytes, modelRequests: this.turns });
  }
  getCapture(stage: string): Data | undefined {
    return this.recorder.events.findLast((e) => e.event === 'request' && e.data.stage === stage)
      ?.data;
  }
}
