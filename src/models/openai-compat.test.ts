import { describe, expect, it } from 'vitest';
import { createOpenAiCompatClient, toOpenAiParams } from './openai-compat.js';
import type { ModelCall } from './types.js';

const base: ModelCall = {
  model: 'llama3',
  maxTokens: 500,
  system: 'stable prompt',
  tools: [{ name: 'now', description: 'current time', inputSchema: { type: 'object', properties: {} } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'time?' }] },
    {
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      content: [{ type: 'thinking', thinking: '', signature: 's' }],
      text: '',
      toolCalls: [{ id: 'call_1', name: 'now', input: {} }],
      stopReason: 'tool_use',
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'call_1', content: '12:00', isError: false },
        { type: 'text', text: 'thanks' },
      ],
    },
  ],
};

describe('toOpenAiParams', () => {
  it('maps the system prompt, function tools and one message for each tool result', () => {
    const params = toOpenAiParams(base);
    expect(params.messages).toEqual([
      { role: 'system', content: 'stable prompt' },
      { role: 'user', content: 'time?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'now', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(params.tools?.[0]).toEqual({
      type: 'function',
      function: { name: 'now', description: 'current time', parameters: base.tools[0]?.inputSchema },
    });
  });
});

describe('createOpenAiCompatClient', () => {
  const reply = (body: unknown, status = 200): typeof fetch => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('normalizes a completion with a tool call and cached tokens', async () => {
    const client = createOpenAiCompatClient('http://localhost:11434/v1', undefined, {
      fetch: reply({
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'llama3',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'now', arguments: 'not json' } }],
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, prompt_tokens_details: { cached_tokens: 100 } },
      }),
    });
    const response = await client.complete(base);
    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([{ id: 'call_2', name: 'now', input: 'not json' }]);
    expect(response.usage).toEqual({ inputTokens: 20, outputTokens: 8, cacheReadTokens: 100, cacheWriteTokens: 0 });
  });

  // some servers end a turn with tool calls with "stop", and the loop runs tools only on tool_use.
  it('treats a turn with tool calls as tool_use, also when the server says stop', async () => {
    const client = createOpenAiCompatClient('http://localhost:11434/v1', undefined, {
      fetch: reply({
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'llama3',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'now', arguments: '{}' } }] },
          },
        ],
      }),
    });
    expect((await client.complete(base)).stopReason).toBe('tool_use');
  });

  // a server that numbers the calls of each reply from call_0 gave the same id twice in one run. after a crash, the
  // repair then gave the second call the recorded result of the first.
  it('gives a new id to a call whose id an earlier call has, or that has no id', async () => {
    const fn = (id: string) => ({ id, type: 'function', function: { name: 'now', arguments: '{}' } });
    const client = createOpenAiCompatClient('http://localhost:11434/v1', undefined, {
      fetch: reply({
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'llama3',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: { role: 'assistant', content: null, tool_calls: [fn('call_1'), fn('call_9'), fn('call_9'), fn('')] },
          },
        ],
      }),
    });
    const ids = (await client.complete(base)).toolCalls.map((call) => call.id);
    expect(ids[1]).toBe('call_9');
    expect(ids[0]).toMatch(/^call_[0-9a-f]{16}$/);
    expect(new Set([...ids, 'call_1']).size).toBe(5);
  });

  it('maps status codes to error kinds', async () => {
    const busy = createOpenAiCompatClient('http://localhost/v1', undefined, { fetch: reply({ error: {} }, 503) });
    await expect(busy.complete(base)).rejects.toMatchObject({ kind: 'transient', status: 503 });
    const bad = createOpenAiCompatClient('http://localhost/v1', undefined, { fetch: reply({ error: {} }, 400) });
    await expect(bad.complete(base)).rejects.toMatchObject({ kind: 'request', status: 400 });
  });
});
