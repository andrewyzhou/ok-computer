import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { createAnthropicClient, fromAnthropicMessage, toAnthropicParams } from './anthropic.js';
import type { AssistantTurn, ModelCall, ModelError } from './types.js';

const tool = { name: 'now', description: 'current time', inputSchema: { type: 'object', properties: {} } };

function call(messages: ModelCall['messages']): ModelCall {
  return { model: 'claude-haiku-5-5', maxTokens: 1000, effort: 'low', system: 'stable prompt', tools: [tool], messages };
}

const nativeTurn: AssistantTurn = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-abc' },
    { type: 'text', text: 'let me check', citations: null },
    { type: 'tool_use', id: 'toolu_1', name: 'now', input: {} },
  ],
  text: 'let me check',
  toolCalls: [{ id: 'toolu_1', name: 'now', input: {} }],
  stopReason: 'tool_use',
};

describe('toAnthropicParams', () => {
  it('renders caching, adaptive thinking, effort and tools without forced tool choice', () => {
    const params = toAnthropicParams(call([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    expect(params.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(params.betas).toEqual(['thinking-binding-controls-2026-08-01']);
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.system).toEqual([{ type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } }]);
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.tools).toEqual([{ name: 'now', description: 'current time', input_schema: tool.inputSchema }]);
    expect(params.tool_choice).toBeUndefined();
  });

  // the digest sends each batch of mail once. a breakpoint at the end of it wrote the whole batch to the cache, and no
  // later call read it.
  it('keeps the breakpoint of the system text and drops the one at the end for a one-shot request', () => {
    const params = toAnthropicParams({ ...call([{ role: 'user', content: [{ type: 'text', text: 'a batch of mail' }] }]), oneShot: true });
    expect(params.system).toEqual([{ type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } }]);
    expect(params.cache_control).toBeUndefined();
    expect('oneShot' in params).toBe(false);
  });

  // the owner writes 15 to 75 minutes apart, so the 5-minute cache expired between messages and each one paid a write.
  it('puts the 1-hour time on both breakpoints of a slot that asks for it, and reads the 1-hour writes', () => {
    const params = toAnthropicParams({ ...call([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), cacheTtl: '1h' });
    expect(params.system).toEqual([{ type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(params.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    };
    const message = { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: 'end_turn', stop_sequence: null, usage };
    expect(fromAnthropicMessage(message as unknown as BetaMessage, 1).usage).toMatchObject({ cacheWriteTokens: 300, cacheWrite1hTokens: 200 });
  });

  it('replays assistant blocks of its own provider without a change', () => {
    const params = toAnthropicParams(
      call([
        { role: 'user', content: [{ type: 'text', text: 'time?' }] },
        { role: 'assistant', ...nativeTurn },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: '12:00', isError: false }] },
      ]),
    );
    expect(JSON.stringify(params.messages[1]?.content)).toBe(JSON.stringify(nativeTurn.content));
    expect(params.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '12:00', is_error: false },
    ]);
  });

  it('rebuilds turns of other providers from text and tool calls', () => {
    const foreign: AssistantTurn = { ...nativeTurn, provider: 'openai-compat', content: [{ role: 'assistant' }] };
    const params = toAnthropicParams(call([{ role: 'user', content: [{ type: 'text', text: 'x' }] }, { role: 'assistant', ...foreign }]));
    expect(params.messages[1]?.content).toEqual([
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'toolu_1', name: 'now', input: {} },
    ]);
  });

  // a local model wrote arguments that were not json, and the api refused every later request of the session.
  it('wraps tool input of another provider that is not an object', () => {
    const foreign: AssistantTurn = { ...nativeTurn, provider: 'openai-compat', toolCalls: [{ id: 'c', name: 'now', input: 'not json' }] };
    const params = toAnthropicParams(call([{ role: 'user', content: [{ type: 'text', text: 'x' }] }, { role: 'assistant', ...foreign }]));
    expect(params.messages[1]?.content).toContainEqual({ type: 'tool_use', id: 'c', name: 'now', input: { _raw: 'not json' } });
  });
});

describe('fromAnthropicMessage', () => {
  it('normalizes text, tool calls, usage and stop reason', () => {
    const message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: nativeTurn.content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: null },
    } as unknown as BetaMessage;
    const response = fromAnthropicMessage(message, 42);
    expect(response.text).toBe('let me check');
    expect(response.toolCalls).toEqual([{ id: 'toolu_1', name: 'now', input: {} }]);
    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0, cacheWrite1hTokens: 0 });
    expect(response.content).toBe(message.content);
    expect(response.warnings).toBeUndefined();
  });

  it('reports thinking blocks that the api dropped', () => {
    const message = {
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }],
    };
    expect(fromAnthropicMessage(message as unknown as BetaMessage, 1).warnings).toEqual([
      'thinking_dropped at messages.1.content.0: prefix_binding_mismatch',
    ]);
  });

  it('maps a refusal', () => {
    const message = { content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } };
    expect(fromAnthropicMessage(message as unknown as BetaMessage, 1).stopReason).toBe('refusal');
  });
});

describe('createAnthropicClient errors', () => {
  const failWith = (status: number): typeof fetch => async () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: `status ${status}` } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const request = call([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);

  it.each([
    [429, 'transient'],
    [529, 'transient'],
    [500, 'transient'],
    [400, 'request'],
    [401, 'request'],
  ])('maps status %i to a %s error', async (status, kind) => {
    const client = createAnthropicClient('test-key', { fetch: failWith(status) });
    await expect(client.complete(request)).rejects.toMatchObject({ name: 'ModelError', kind, status });
  });

  it('maps a network failure to a transient error', async () => {
    const client = createAnthropicClient('test-key', {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(client.complete(request)).rejects.toMatchObject({ kind: 'transient' });
  });
});

describe('createAnthropicClient streaming', () => {
  const request = call([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [] as unknown[],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
  };
  const events = [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

  it('sends the same body with stream: true, gives the text so far, and returns the same response', async () => {
    const bodies: unknown[] = [];
    const client = createAnthropicClient('test-key', {
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const seen: string[] = [];
    const response = await client.complete(request, undefined, (text) => seen.push(text));
    expect(bodies).toEqual([{ ...JSON.parse(JSON.stringify(toAnthropicParams(request))), stream: true }].map(({ betas: _betas, ...body }) => body));
    expect(seen).toEqual(['Hello ', 'Hello there.']);
    expect(response).toMatchObject({
      text: 'Hello there.',
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 },
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'text', text: 'Hello there.' },
      ],
    });
  });

  // an overload can arrive as an error event after the stream started with a 200. it has no status, so it was a
  // request error, and the run failed without a retry.
  it('takes an overload inside a stream as transient, and a bad request inside a stream as a request error', async () => {
    const broken = (type: string) =>
      createAnthropicClient('test-key', {
        fetch: async () =>
          new Response(
            `event: message_start\ndata: ${JSON.stringify(events[0])}\n\nevent: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: 'boom' } })}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      });
    await expect(broken('overloaded_error').complete(request, undefined, () => {})).rejects.toMatchObject({ name: 'ModelError', kind: 'transient' });
    await expect(broken('api_error').complete(request, undefined, () => {})).rejects.toMatchObject({ kind: 'transient' });
    await expect(broken('invalid_request_error').complete(request, undefined, () => {})).rejects.toMatchObject({ kind: 'request', status: 400 });
    // verification round 4: every other type was a request error with status 0, which counts as an error of the input.
    await expect(broken('rate_limit_error').complete(request, undefined, () => {})).rejects.toMatchObject({ kind: 'transient', status: 429 });
    await expect(broken('timeout_error').complete(request, undefined, () => {})).rejects.toMatchObject({ kind: 'transient' });
    await expect(broken('authentication_error').complete(request, undefined, () => {})).rejects.toMatchObject({ kind: 'request', status: 401 });
  });

  // a stream stays open for the whole reply, so a cut in the middle is the usual network failure. the sdk then
  // throws its base error, which went up raw: no retry and no row for the call.
  it('takes a stream that ends early, breaks, or sends bad json as transient', async () => {
    const answering = (body: () => string | ReadableStream) =>
      createAnthropicClient('test-key', {
        fetch: async () => new Response(body(), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      });
    const reset = () => {
      let sent = false;
      return new ReadableStream({
        pull(controller) {
          if (sent) return controller.error(new TypeError('terminated'));
          sent = true;
          controller.enqueue(new TextEncoder().encode(sse.slice(0, sse.indexOf('event: content_block_stop'))));
        },
      });
    };
    for (const body of [() => sse.slice(0, sse.indexOf('event: message_delta')), reset, () => 'event: message_start\ndata: {not json\n\n']) {
      await expect(answering(body).complete(request, undefined, () => {})).rejects.toMatchObject({ name: 'ModelError', kind: 'transient' });
    }
  });

  // the owner saw the text of a cut stream in the draft, and its tokens are billed, so the error carries them.
  it('gives the text and the usage that a stream sent before it was cut', async () => {
    const cut = createAnthropicClient('test-key', {
      fetch: async () => new Response(sse.slice(0, sse.indexOf('event: message_stop')), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const error = (await cut.complete(request, undefined, () => {}).catch((err: unknown) => err)) as ModelError;
    expect(error).toMatchObject({ kind: 'transient', partial: { text: 'Hello there.', usage: { inputTokens: 12, outputTokens: 7 } } });
    // the stop button aborts the stream after the text went to the draft.
    const abort = new AbortController();
    const held = createAnthropicClient('test-key', {
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse.slice(0, sse.lastIndexOf('event: content_block_stop'))));
              init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const stopped = held.complete(request, abort.signal, (text) => text === 'Hello there.' && abort.abort()).catch((err: unknown) => err);
    expect(await stopped).toMatchObject({ kind: 'aborted', partial: { text: 'Hello there.', usage: { inputTokens: 12 } } });
    // a plain request has no partial message.
    const plain = createAnthropicClient('test-key', { fetch: async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }) });
    expect(((await plain.complete(request).catch((err: unknown) => err)) as ModelError).partial).toBeUndefined();
  });

  it('maps a refused stream and an abort to the same errors as a plain request', async () => {
    const limited = createAnthropicClient('test-key', {
      fetch: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: 429 }),
    });
    await expect(limited.complete(request, undefined, () => {})).rejects.toMatchObject({ name: 'ModelError', kind: 'transient', status: 429 });

    const abort = new AbortController();
    const hanging = createAnthropicClient('test-key', {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    const pending = hanging.complete(request, abort.signal, () => {});
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'ModelError', kind: 'aborted' });
  });
});
