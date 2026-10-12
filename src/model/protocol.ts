import type { ServerResponse } from 'node:http';
import { obj, arr, CanaryError, type Data } from '../types.js';
export function requestProjection(body: Data, knownIds: Set<string>, nonce: string): Data {
  const tools = arr(body.tools)
    .map(obj)
    .filter((t) => /^mcp__canary__lookup_(record|summary)$/.test(String(t.name)))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
      defer_loading: t.defer_loading === true,
    }));
  const results = arr(body.messages)
    .flatMap((m) => arr(obj(m).content))
    .map(obj)
    .filter((c) => c.type === 'tool_result' && knownIds.has(String(c.tool_use_id)))
    .map((c) => ({
      toolUseId: c.tool_use_id,
      isError: c.is_error === true,
      references: arr(c.content)
        .map(obj)
        .filter((b) => b.type === 'tool_reference')
        .map((b) => ({ type: 'tool_reference', tool_name: b.tool_name })),
      inlineDefinitions: arr(c.content)
        .map(obj)
        .filter((b) => b.type === 'tool_definition' && /^mcp__canary__/.test(String(b.name)))
        .map((b) => ({ name: b.name, description: b.description, inputSchema: b.input_schema })),
    }));
  const search = arr(body.tools)
    .map(obj)
    .find((t) => t.name === 'ToolSearch');
  return {
    tools,
    results,
    noncePresent: JSON.stringify(body.messages ?? []).includes(nonce),
    toolSearchPresent: !!search,
  };
}
export function searchInvocation(
  body: Data,
  targetShortName: string,
): { name: string; input: Data; targetName: string } {
  const search = arr(body.tools)
    .map(obj)
    .find((t) => t.name === 'ToolSearch');
  if (!search) throw new CanaryError('ToolSearch missing in observed native request', 3);
  const targetName = 'mcp__canary__' + targetShortName;
  if (!JSON.stringify(body).includes(targetName))
    throw new CanaryError('Synthetic target absent from observed native request inventory', 3);
  const schema = obj(search.input_schema),
    props = obj(schema.properties);
  if (
    obj(props.query).type !== 'string' ||
    obj(props.max_results).type !== 'number' ||
    arr(schema.required).some((k) => !['query', 'max_results'].includes(String(k)))
  )
    throw new CanaryError('ToolSearch input protocol drift', 3);
  return {
    name: String(search.name),
    input: { query: 'select:' + targetName, max_results: 1 },
    targetName,
  };
}
export type MockBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Data };
export function messagesResponse(
  res: ServerResponse,
  body: Data,
  content: MockBlock[],
  counter: number,
): void {
  const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = {
    id: 'msg_canary_' + counter,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type: string, data: Data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  content.forEach((block, index) => {
    event('content_block_start', {
      index,
      content_block:
        block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      index,
      delta:
        block.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
          : { type: 'text_delta', text: block.text },
    });
    event('content_block_stop', { index });
  });
  event('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: message.usage,
  });
  event('message_stop', {});
  res.end();
}
