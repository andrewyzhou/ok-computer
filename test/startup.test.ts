import { describe, expect, it } from 'vitest';
import { getApproval } from '../src/approvals/store.js';
import { appendEvent, listEvents } from '../src/events/log.js';
import { textStep } from '../src/models/fake.js';
import { createTestApp } from './app-harness.js';
import { danglingToolCalls } from './harness.js';

const pdt = (time: string, day = '2026-10-12') => new Date(`${day}T${time}:00-07:00`).toISOString();

describe('the start of the app after a stop', () => {
  it('closes the stale work of the stopped process, and expires an approved call that never started', async () => {
    const t = createTestApp([textStep('I am back.')], { start: pdt('09:00') });
    const run = (id: string, startedAt: string) =>
      t.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, 'main', 'message', 'main', 'running', ?)").run(id, startedAt);
    // the old process stopped at 07:00 in the middle of a tool call.
    run('crashed', pdt('07:00'));
    const at = new Date(pdt('07:00'));
    appendEvent(t.db, { sessionKey: 'main', runId: 'crashed', type: 'user_message', payload: { text: 'what time is it', channel: 'cli', chatId: 'local' } }, at);
    appendEvent(
      t.db,
      {
        sessionKey: 'main',
        runId: 'crashed',
        type: 'assistant_message',
        payload: { provider: 'fake', model: 'm', content: [], text: '', toolCalls: [{ id: 't1', name: 'now', input: {} }], stopReason: 'tool_use' },
      },
      at,
    );
    t.db.prepare("INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, createdAt) VALUES ('crashed', 't1', 'now', 'allow', 'risk:read', 'x', 'x')").run();
    // the owner approved a send at 07:00, and the process stopped before it ran.
    t.db
      .prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt, resolvedAt) VALUES ('crashed', 'send', '{}', 'send x', 'approved', ?, ?)")
      .run(pdt('06:59'), pdt('07:00'));
    // another process runs this session now, for example the service while the owner uses npm run chat.
    run('live', pdt('08:59'));

    await t.app.start();
    await t.settle();
    expect(t.rows('SELECT id, status FROM runs ORDER BY id')).toEqual([
      { id: 'crashed', status: 'aborted' },
      { id: 'live', status: 'running' },
    ]);
    expect(getApproval(t.db, 1)).toMatchObject({ status: 'expired' });
    expect(t.rows("SELECT COUNT(*) AS n FROM tool_calls WHERE toolCallId = 'approval-1'")).toEqual([{ n: 0 }]);
    expect(t.printed()).toContain('Approval #1 (send x) was approved, but the app stopped before it ran, so it expired and did not run.');
    expect(listEvents(t.db, 'main').filter((event) => event.type === 'system_event').map((event) => event.payload.text)).toEqual([
      expect.stringContaining('Approval #1 (send x) was approved, but the app stopped before it ran'),
    ]);

    await t.say('are you there');
    expect(t.printed()).toContain('okc> I am back.');
    // the next run of the session gave the call of the stopped process its result.
    expect(t.rows("SELECT outcome FROM tool_calls WHERE toolCallId = 't1'")).toEqual([{ outcome: 'interrupted' }]);
    expect(danglingToolCalls(t.model.calls[0]!.messages)).toEqual([]);
    await t.app.stop();
  });

  it('tells the session when a pending approval expires after 24 hours', async () => {
    const t = createTestApp([], { start: pdt('09:00') });
    t.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
    t.db.prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES ('r1', 'send', '{}', 'send x', 'pending', ?)").run(pdt('09:00'));
    await t.app.start();
    await t.at(pdt('09:01', '2026-10-13'));
    expect(getApproval(t.db, 1)!.status).toBe('expired');
    // the morning brief of 07:30 also puts its copy in the session, so the note is not always the last event.
    expect(listEvents(t.db, 'main').filter((event) => event.type === 'system_event').map((event) => event.payload.text)).toContain(
      'Approval #1 (send x) expired after 24 hours without an answer. The tool did not run.',
    );
    await t.app.stop();
  });
});
