import { describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '../../../../src/dashboard/types';
import { isActive, standaloneReducer, turnsReducer, type TurnAction, type Turns } from '../../chat-stream';

const run = (events: TurnAction[], start: Turns = new Map()) => events.reduce(turnsReducer, start);

const reply = (turnId: string | null, text: string): ChatStreamEvent => ({
  kind: 'reply',
  turnId,
  messageId: `m-${text}`,
  runId: 'run-9',
  text,
  markdown: false,
  details: null,
  buttons: [[{ text: 'Approve', data: 'approve:1' }]],
  at: '2026-10-13T01:00:00.000Z',
});

describe('turnsReducer', () => {
  it('builds a turn from the owner message to the reply', () => {
    const turns = run([
      { kind: 'owner', turnId: 'web:1', channel: 'web', text: 'hello', at: '2026-10-13T01:00:00.000Z' },
      { kind: 'state', turnId: 'web:1', state: 'running' },
      { kind: 'run', turnId: 'web:1', runId: 'run-9' },
      { kind: 'activity', turnId: 'web:1', tools: 'goals_set' },
      { kind: 'text', turnId: 'web:1', delta: 'Hel', reset: false },
      { kind: 'text', turnId: 'web:1', delta: 'lo', reset: false },
    ]);
    expect(turns.get('web:1')).toEqual({
      turnId: 'web:1',
      channel: 'web',
      ownerText: 'hello',
      state: 'running',
      runId: 'run-9',
      text: 'Hello',
      activity: 'goals_set',
    });
  });

  it('drops the streamed text on a reset', () => {
    const turns = run([
      { kind: 'text', turnId: 'web:1', delta: 'first try', reset: false },
      { kind: 'text', turnId: 'web:1', delta: 'Second', reset: true },
      { kind: 'text', turnId: 'web:1', delta: ' try', reset: false },
    ]);
    expect(turns.get('web:1')!.text).toBe('Second try');
  });

  it('lets the reply replace the streamed text, and keeps a reply with no turn apart', () => {
    const events: ChatStreamEvent[] = [
      { kind: 'text', turnId: 'web:1', delta: 'draft', reset: false },
      { kind: 'activity', turnId: 'web:1', tools: 'now' },
      reply('web:1', 'Final answer.'),
      reply(null, 'Approve the email?'),
    ];
    const turns = run(events);
    const turn = turns.get('web:1')!;
    expect(turn.text).toBe('');
    expect(turn.activity).toBeNull();
    expect(turn.reply).toEqual({ text: 'Final answer.', markdown: false, details: null, buttons: [[{ text: 'Approve', data: 'approve:1' }]], messageId: 'm-Final answer.' });
    expect(turns.size).toBe(1);
    const standalone = events.reduce(standaloneReducer, []);
    expect(standalone.map((each) => each.text)).toEqual(['Approve the email?']);
    // the same reply twice, for example after a reconnect, shows once.
    expect(standaloneReducer(standalone, reply(null, 'Approve the email?'))).toBe(standalone);
  });

  it('ends a turn on done, keeps a stopped turn stopped, and drops turns on request', () => {
    const turns = run([
      { kind: 'state', turnId: 'web:1', state: 'running' },
      { kind: 'state', turnId: 'web:2', state: 'running' },
      { kind: 'state', turnId: 'web:2', state: 'stopped' },
      { kind: 'done', turnId: 'web:1', ok: true },
      { kind: 'done', turnId: 'web:2', ok: false },
      { kind: 'error', turnId: 'web:2', error: 'the model failed' },
    ]);
    expect(turns.get('web:1')!.state).toBe('done');
    expect(turns.get('web:2')!.state).toBe('stopped');
    expect(turns.get('web:2')!.error).toBe('the model failed');
    expect(isActive(turns.get('web:1')!)).toBe(false);
    expect([...run([{ kind: 'drop', turnIds: ['web:1'] }], turns).keys()]).toEqual(['web:2']);
    // the end of a turn that the page never saw adds nothing.
    expect(run([{ kind: 'state', turnId: 'web:3', state: 'done' }, { kind: 'done', turnId: 'web:3', ok: true }]).size).toBe(0);
  });

  it('replaces every turn with a snapshot, and keeps the owner text that the snapshot lacks', () => {
    const before = run([
      { kind: 'owner', turnId: 'telegram:5', channel: 'telegram', text: 'from the phone', at: '2026-10-13T01:00:00.000Z' },
      { kind: 'state', turnId: 'web:1', state: 'running' },
    ]);
    const after = run(
      [
        {
          kind: 'snapshot',
          turns: [{ turnId: 'telegram:5', channel: 'telegram', state: 'running', runId: 'run-7', text: 'so far', activity: null }],
        },
      ],
      before,
    );
    expect([...after.keys()]).toEqual(['telegram:5']);
    expect(after.get('telegram:5')).toEqual({
      turnId: 'telegram:5',
      channel: 'telegram',
      ownerText: 'from the phone',
      state: 'running',
      runId: 'run-7',
      text: 'so far',
      activity: null,
    });
  });

  it('takes the state of the post for a sent turn, and the channel from the turn id for an unknown one', () => {
    const turns = run([
      { kind: 'sent', turnId: 'web:1', text: 'hi', state: 'queued' },
      { kind: 'text', turnId: 'telegram:9', delta: 'x', reset: false },
    ]);
    expect(turns.get('web:1')).toMatchObject({ ownerText: 'hi', state: 'queued', channel: 'web' });
    expect(turns.get('telegram:9')!.channel).toBe('telegram');
    // a kind that the page does not know changes nothing.
    expect(turnsReducer(turns, { kind: 'ping' } as unknown as TurnAction)).toBe(turns);
  });
});
