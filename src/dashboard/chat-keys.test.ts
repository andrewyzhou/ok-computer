import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { chatKeyOf, chatKindOf, mainSegments, parseChatKey } from './chat-keys.js';
import { idOf, limitOf } from './params.js';

describe('the chat keys', () => {
  it('gives the kind of each session key', () => {
    expect(['main', 'auto:a1:run-1', 'heartbeat:run-2', 'sub:research:r', 'consolidate:2026-10-12', 'workshop:x', 'poll:google', 'cli'].map(chatKindOf)).toEqual([
      'main',
      'auto',
      'heartbeat',
      'sub',
      'consolidate',
      'workshop',
      'poll',
      'other',
    ]);
  });

  it('parses main segments and background keys, and refuses the rest', () => {
    expect(parseChatKey('main@0')).toEqual({ sessionKey: 'main', resetEventId: 0 });
    expect(parseChatKey('main@42')).toEqual({ sessionKey: 'main', resetEventId: 42 });
    expect(parseChatKey('heartbeat:run-2')).toEqual({ sessionKey: 'heartbeat:run-2', resetEventId: null });
    for (const bad of ['', 'main', 'main@', 'main@-1', 'main@01', 'main@1.5', 'main@x', 'x'.repeat(301)]) expect(parseChatKey(bad), bad).toBeUndefined();
  });

  it('splits main at each reset and finds the segment of an event', () => {
    const db = openDb(':memory:');
    const say = (text: string) => appendEvent(db, { sessionKey: 'main', runId: null, type: 'note', payload: { text } }).id;
    const first = say('one');
    const reset = appendEvent(db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} }).id;
    const after = say('two');
    const other = appendEvent(db, { sessionKey: 'heartbeat:r', runId: null, type: 'note', payload: { text: 'x' } }).id;
    expect(mainSegments(db)).toEqual([
      { key: 'main@0', resetEventId: 0, fromEventId: 0, toEventId: reset - 1 },
      { key: `main@${reset}`, resetEventId: reset, fromEventId: reset, toEventId: null },
    ]);
    expect([first, reset, after].map((id) => chatKeyOf(db, 'main', id))).toEqual(['main@0', `main@${reset}`, `main@${reset}`]);
    expect(chatKeyOf(db, 'heartbeat:r', other)).toBe('heartbeat:r');
  });
});

describe('the query rules', () => {
  it('clamps a limit and gives the default for a value that is not a number', () => {
    expect([undefined, '', 'x', '0', '-5', '7', '7.9', '999'].map((value) => limitOf(value, 200, 50))).toEqual([50, 50, 50, 1, 1, 7, 7, 200]);
  });

  it('reads a positive whole id', () => {
    expect([undefined, '', '0', '-1', '1.5', 'x', '12'].map(idOf)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 12]);
  });
});
