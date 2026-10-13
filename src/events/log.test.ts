import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { registerSecret } from '../observability/redact.js';
import { appendEvent, listEvents } from './log.js';

describe('event log', () => {
  it('numbers events per session in order', () => {
    const db = openDb(':memory:');
    const user = { text: 'hi', channel: 'cli', chatId: 'local' };
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'user_message', payload: user });
    appendEvent(db, { sessionKey: 'other', runId: null, type: 'note', payload: { text: 'x' } });
    const second = appendEvent(db, { sessionKey: 'main', runId: 'r1', type: 'note', payload: { text: 'y' } });
    expect(second.seq).toBe(2);
    expect(second.runId).toBe('r1');
    const events = listEvents(db, 'main');
    expect(events.map((e) => e.type)).toEqual(['user_message', 'note']);
    expect(events[0]?.payload).toEqual(user);
  });

  it('rejects updates and deletes in the database', () => {
    const db = openDb(':memory:');
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'note', payload: { text: 'keep me' } });
    expect(() => db.exec("UPDATE events SET payload = '{}'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(listEvents(db, 'main')[0]?.payload).toEqual({ text: 'keep me' });
  });

  it('redacts registered secrets in stored payloads', () => {
    const db = openDb(':memory:');
    registerSecret('super-secret-value-123');
    const event = appendEvent(db, {
      sessionKey: 'main',
      runId: null,
      type: 'note',
      payload: { text: 'key is super-secret-value-123 and sk-ant-abcdefghijklmnop' },
    });
    expect(event.payload).toEqual({ text: 'key is [redacted] and [redacted]' });
  });
});
