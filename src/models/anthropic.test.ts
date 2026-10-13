import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { createAnthropicClient, fromAnthropicMessage, toAnthropicParams } from './anthropic.js';
import type { AssistantTurn, ModelCall } from './types.js';

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
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 });
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
