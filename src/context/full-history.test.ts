import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent, listEvents, type NewEvent } from '../events/log.js';
import { toAnthropicParams } from '../models/anthropic.js';
import type { AssistantTurn, ToolSpec } from '../models/types.js';
import { fullHistory } from './full-history.js';

const tools: ToolSpec[] = [{ name: 'now', description: 'time', inputSchema: { type: 'object', properties: {} } }];

const toolTurn: AssistantTurn = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'EqQBCkYIBxgCKkB' },
    { type: 'tool_use', id: 'toolu_1', name: 'now', input: {}, caller: { type: 'direct' } },
  ],
  text: '',
  toolCalls: [{ id: 'toolu_1', name: 'now', input: {} }],
  stopReason: 'tool_use',
};

const answerTurn: AssistantTurn = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: 'it is noon', citations: null }],
  text: 'it is noon',
  toolCalls: [],
  stopReason: 'end_turn',
};

function session(events: Array<Omit<NewEvent, 'sessionKey' | 'runId'>>) {
  const db = openDb(':memory:');
  const add = (list: typeof events) =>
    list.forEach((e) => appendEvent(db, { sessionKey: 'main', runId: 'r', ...e } as NewEvent));
  add(events);
  const render = async () =>
    toAnthropicParams({
      ...(await fullHistory.build({ sessionKey: 'main', events: listEvents(db, 'main'), system: 'stable', tools })),
      model: 'claude-sonnet-5-5',
      maxTokens: 1000,
      effort: 'medium',
    });
  return { add, render };
}

const user = (text: string) => ({ type: 'user_message' as const, payload: { text, channel: 'cli', chatId: 'local' } });
const context = (text: string) => ({ type: 'context' as const, payload: { text } });

describe('full-history strategy', () => {
  it('groups tool results and context into user turns', async () => {
    const { render } = session([
      user('what time is it'),
      context('<context>a</context>'),
      { type: 'assistant_message', payload: toolTurn },
      { type: 'tool_result', payload: { toolCallId: 'toolu_1', name: 'now', content: '12:00', isError: false } },
    ]);
    const params = await render();
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(params.messages[0]?.content).toEqual([
      { type: 'text', text: 'what time is it' },
      { type: 'text', text: '<context>a</context>' },
    ]);
  });

  it('repeats the previous request as an exact prefix when the session grows', async () => {
    const { add, render } = session([user('what time is it'), context('<context>a</context>')]);
    const turns: Array<Awaited<ReturnType<typeof render>>> = [await render()];
    add([
      { type: 'assistant_message', payload: toolTurn },
      { type: 'tool_result', payload: { toolCallId: 'toolu_1', name: 'now', content: '12:00', isError: false } },
    ]);
    turns.push(await render());
    add([{ type: 'assistant_message', payload: answerTurn }, user('thanks'), context('<context>b</context>')]);
    turns.push(await render());

    for (let i = 1; i < turns.length; i++) {
      const before = turns[i - 1]!;
      const after = turns[i]!;
      expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
      expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
      const shared = after.messages.slice(0, before.messages.length);
      expect(JSON.stringify(shared)).toBe(JSON.stringify(before.messages));
    }
  });

  it('replays the stored assistant blocks without a change', async () => {
    const { render } = session([user('time?'), { type: 'assistant_message', payload: toolTurn }]);
    const params = await render();
    expect(JSON.stringify(params.messages[1]?.content)).toBe(JSON.stringify(toolTurn.content));
  });

  it('starts after the most recent session reset', async () => {
    const { render } = session([
      user('old topic'),
      { type: 'assistant_message', payload: answerTurn },
      { type: 'session_reset', payload: {} },
      user('new topic'),
    ]);
    const params = await render();
    expect(params.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'new topic' }] }]);
  });
});
