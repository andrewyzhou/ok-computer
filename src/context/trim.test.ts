import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../events/log.js';
import { CLEARED, stripThinking, trimToolResults } from './trim.js';

let id = 0;
const event = (type: string, payload: object) => ({ id: ++id, sessionKey: 'main', runId: 'r', seq: id, type, payload, createdAt: '' }) as StoredEvent;
const turn = (content: unknown[] = []) =>
  event('assistant_message', { provider: 'anthropic', model: 'm', content, text: '', toolCalls: [], stopReason: 'tool_use' });
const result = (content: string) => event('tool_result', { toolCallId: 't', name: 'now', content, isError: false });
const long = 'a'.repeat(1500) + 'b'.repeat(2000) + 'c'.repeat(1500);

describe('trimToolResults', () => {
  it('cuts old long results to their head and tail and keeps the last three turns as they are', () => {
    const events = [turn(), result(long), turn(), result(long), turn(), result(long), turn(), result(long), result('short')];
    const trimmed = trimToolResults(events, false);
    const content = (e: StoredEvent) => (e.type === 'tool_result' ? e.payload.content : '');
    expect(content(trimmed[1]!)).toBe(`${'a'.repeat(1500)}\n[... 2000 characters cut ...]\n${'c'.repeat(1500)}`);
    expect(trimmed.slice(2)).toEqual(events.slice(2));
    expect(content(events[1]!)).toBe(long);
  });

  it('clears all old results when asked', () => {
    const events = [turn(), result('x'), turn(), turn(), turn()];
    expect(trimToolResults(events, true)[1]).toMatchObject({ payload: { content: CLEARED } });
    const short = [turn(), result('x'), turn()];
    expect(trimToolResults(short, true)).toEqual(short);
  });

  it('keeps the handle of a cleared result, so the model can read it again', () => {
    const preview = 'start\n[...]\nend\n[this result has 9000 characters. the full result is res_0123456789ab. use result_read.]';
    const events = [turn(), result(preview), turn(), turn(), turn()];
    expect(trimToolResults(events, true)[1]).toMatchObject({
      payload: { content: `${CLEARED} the full result is res_0123456789ab.` },
    });
  });

  it('removes thinking blocks from assistant turns only', () => {
    const withThinking = turn([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'text', text: 'hi' },
    ]);
    expect(stripThinking(withThinking)).toMatchObject({ payload: { content: [{ type: 'text', text: 'hi' }] } });
    expect(withThinking.type === 'assistant_message' && withThinking.payload.content).toHaveLength(3);
    const plain = result('x');
    expect(stripThinking(plain)).toBe(plain);
  });
});
