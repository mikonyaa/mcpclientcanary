import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createOwned, childEnvironment } from '../../dist/native/isolation.js';
import { writeControl } from '../../dist/server/phase-control.js';
import { readEvents } from '../../dist/evidence/collector.js';
import { definitions } from '../../dist/server/definitions.js';
import { CORE, PROTOCOL } from '../../dist/types.js';
for (const scenario of CORE)
  test(`Independent SDK server check: ${scenario}`, { timeout: 10000 }, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'canary-sdk-'));
    const owned = await createOwned(parent);
    const phase = scenario === 'fresh-b' ? 'B' : 'A';
    const control = { schemaVersion: 1, runId: owned.runId, scenario, phase, generation: 1 };
    let client;
    async function connect() {
      const c = new Client(
        { name: 'independent-server-check', version: '1' },
        { capabilities: {} },
      );
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            resolve('dist/server/fixture-server.js'),
            owned.root,
            owned.control,
            owned.serverEvidence,
          ],
          env: childEnvironment(owned.config),
          stderr: 'pipe',
        }),
      );
      return c;
    }
    try {
      await writeControl(owned.root, owned.control, control);
      client = await connect();
      assert.equal(client.getServerCapabilities().tools.listChanged, true);
      assert.deepEqual((await client.listTools()).tools, definitions(control));
      const invalid = await client.callTool({
        name: 'lookup_record',
        arguments: { recordId: 'own', arbitrary: 'no' },
      });
      assert.equal(invalid.isError, true);
      const valid = await client.callTool({
        name: 'lookup_record',
        arguments:
          scenario === 'fresh-b' ? { recordId: 'own', detail: 'summary' } : { recordId: 'own' },
      });
      assert.notEqual(valid.isError, true);
      const notification = new Promise((r) =>
        client.setNotificationHandler(ToolListChangedNotificationSchema, r),
      );
      const next = { ...control, phase: scenario === 'no-change' ? 'A' : 'B', generation: 2 };
      await writeControl(owned.root, owned.control, next);
      await notification;
      const live = (await client.listTools()).tools;
      assert.deepEqual(live, definitions(next));
      const events = readEvents(owned.serverEvidence);
      assert(events.some((e) => e.data.negotiatedProtocol === PROTOCOL));
      const start = events.find((e) => e.event === 'server-start'),
        changed = events.find((e) => e.event === 'phase-applied');
      assert.equal(start.instance, changed.instance);
      const sent = events.find(
        (e) => e.event === 'sent' && e.data.method === 'notifications/tools/list_changed',
      );
      assert(changed.seq < sent.seq);
      assert(
        events.some(
          (e) => e.event === 'sent' && e.data.method === 'tools/list' && e.generation === 2,
        ),
      );
      await client.close();
      client = await connect();
      assert.deepEqual((await client.listTools()).tools, definitions(next));
      assert.equal(
        readEvents(owned.serverEvidence).filter((e) => e.event === 'server-start').length,
        2,
      );
    } finally {
      await client?.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
