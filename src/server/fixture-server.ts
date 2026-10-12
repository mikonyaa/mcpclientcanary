import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { realpath, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readControl, within } from './phase-control.js';
import { definitions, hashes, validateArguments } from './definitions.js';
import { Recorder } from '../evidence/collector.js';
import { PROTOCOL, VERSION, obj, arr, CanaryError } from '../types.js';

export async function serve(
  root: string,
  controlPath: string,
  evidencePath: string,
): Promise<void> {
  await within(root, evidencePath);
  let control = await readControl(root, controlPath);
  if (
    (await readFile(await within(root, resolve(root, '.canary-owner')), 'utf8')) !== control.runId
  )
    throw new CanaryError('Fixture ownership marker does not match control runId');
  const recorder = new Recorder('server', evidencePath);
  const pending = new Map<string, string>();
  const emit = (event: string, data: Record<string, unknown>, direction: 'in' | 'out' | 'local') =>
    recorder.add(event, data, control.phase, control.generation, direction);
  emit(
    'server-start',
    { runId: control.runId, protocolMode: 'stateful-stdio', supportedRevision: PROTOCOL },
    'local',
  );
  const server = new Server(
    { name: 'mcpclientcanary-fixture', version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions(control) }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const tool = definitions(control).find((t) => t.name === r.params.name);
    if (!tool)
      return { isError: true, content: [{ type: 'text', text: 'Unknown synthetic tool' }] };
    const parsed = validateArguments(tool, r.params.arguments);
    return parsed.success
      ? {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                synthetic: true,
                generation: control.generation,
                arguments: parsed.data,
              }),
            },
          ],
        }
      : { isError: true, content: [{ type: 'text', text: 'Invalid synthetic arguments' }] };
  });
  const stdio = new StdioServerTransport();
  const transport: Transport = {
    async start() {
      stdio.onmessage = (m) => {
        const d = obj(m);
        if (typeof d.method === 'string') {
          if ('id' in d) pending.set(String(d.id), d.method);
          const p = obj(d.params);
          emit(
            'request',
            {
              method: d.method,
              ...('id' in d ? { requestId: d.id } : {}),
              ...(d.method === 'initialize'
                ? { proposedProtocol: p.protocolVersion, clientVersion: obj(p.clientInfo).version }
                : {}),
              ...(d.method === 'tools/call' ? { name: p.name, arguments: p.arguments } : {}),
            },
            'in',
          );
        }
        transport.onmessage?.(m);
      };
      stdio.onclose = () => {
        emit('stream-end', {}, 'local');
        transport.onclose?.();
      };
      stdio.onerror = (e) => {
        emit('protocol-error', { reason: e.message }, 'local');
        transport.onerror?.(e);
      };
      await stdio.start();
    },
    async send(message: JSONRPCMessage) {
      await stdio.send(message);
      const d = obj(message);
      const method = 'id' in d ? pending.get(String(d.id)) : d.method;
      const result = obj(d.result);
      if (
        method === 'initialize' &&
        typeof result.protocolVersion === 'string' &&
        result.protocolVersion !== PROTOCOL
      )
        throw new CanaryError('Negotiated protocol differs from pinned revision');
      emit(
        'sent',
        {
          method,
          ...('id' in d ? { requestId: d.id } : {}),
          ...(method === 'initialize' ? { negotiatedProtocol: result.protocolVersion } : {}),
          ...(method === 'tools/list'
            ? {
                tools: arr(result.tools).map((t) => ({
                  ...obj(t),
                  ...hashes(t as ReturnType<typeof definitions>[number]),
                })),
              }
            : {}),
          ...('error' in d ? { errorCode: obj(d.error).code } : {}),
          ...(method === 'tools/call' ? { result } : {}),
        },
        'out',
      );
    },
    async close() {
      await stdio.close();
    },
  };
  await server.connect(transport);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const next = await readControl(root, controlPath);
      if (next.runId !== control.runId) throw new CanaryError('Control ownership changed');
      const barrierChanged = next.barrierToken && next.barrierToken !== control.barrierToken;
      if (next.generation !== control.generation) {
        if (next.generation !== 2 || control.generation !== 1)
          throw new CanaryError('Invalid phase transition');
        control = next;
        const transition = emit(
          'phase-applied',
          {
            runId: control.runId,
            tools: definitions(control).map((t) => ({ name: t.name, ...hashes(t) })),
          },
          'local',
        );
        await server.sendToolListChanged();
        emit('notification-complete', { transitionRef: transition.ref }, 'local');
      } else control = next;
      if (barrierChanged)
        emit(
          'stream-checkpoint',
          {
            barrierToken: control.barrierToken,
            tools: definitions(control).map((t) => ({ name: t.name, ...hashes(t) })),
          },
          'local',
        );
    })()
      .catch((e) => {
        emit(
          'server-error',
          { reason: e instanceof CanaryError ? e.message : 'Fixture validation or I/O error' },
          'local',
        );
        clearInterval(timer);
        process.exitCode = 2;
        void server.close();
      })
      .finally(() => (busy = false));
  }, 30);
  process.stdin.on('end', () => {
    clearInterval(timer);
    void server.close().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    clearInterval(timer);
    void server.close().finally(() => process.exit(0));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const [root, control, evidence] = process.argv.slice(2);
  if (!root || !control || !evidence) {
    process.stderr.write('fixture-server needs owned root, control and evidence paths\n');
    process.exitCode = 2;
  } else {
    await serve(root, control, evidence).catch((e) => {
      process.stderr.write(String(e) + '\n');
      process.exitCode = 2;
    });
  }
}
