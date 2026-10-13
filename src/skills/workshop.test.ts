import { describe, expect, it } from 'vitest';
import { describeInput } from '../approvals/flow.js';
import { openDb, type Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { registerSecret } from '../observability/redact.js';
import { findTasks, LONG_TASK_CALLS } from './workshop.js';

const tz = 'America/Los_Angeles';
const at = (time: string, day = '2026-10-12') => new Date(`${day}T${time}:00-07:00`);

// run adds a message run of the main session with the owner's text and the given number of tool calls.
function run(db: Db, id: string, time: Date, text: string, calls = 0, untrusted?: string) {
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, 'main', 'message', 'main', 'completed', ?)").run(id, time.toISOString());
  const add = (event: Parameters<typeof appendEvent>[1]) => appendEvent(db, event, time);
  add({ sessionKey: 'main', runId: id, type: 'user_message', payload: { text, channel: 'cli', chatId: 'c' } });
  const toolCalls = Array.from({ length: calls }, (_, i) => ({ id: `${id}-${i}`, name: 'now', input: {} }));
  if (calls) add({ sessionKey: 'main', runId: id, type: 'assistant_message', payload: { provider: 'fake', model: 'm', content: [], text: '', toolCalls, stopReason: 'tool_use' } });
  for (const call of toolCalls) {
    add({ sessionKey: 'main', runId: id, type: 'tool_result', payload: { toolCallId: call.id, name: 'now', content: 'x', isError: false, ...(untrusted ? { untrustedSource: untrusted } : {}) } });
  }
  add({ sessionKey: 'main', runId: id, type: 'assistant_message', payload: { provider: 'fake', model: 'm', content: [], text: `reply ${id}`, toolCalls: [], stopReason: 'end_turn' } });
}

describe('findTasks', () => {
  it('finds long runs of the day and corrections of a run with tools, and joins runs that touch', () => {
    const db = openDb(':memory:');
    run(db, 'old', at('10:00', '2026-10-11'), 'long task of the day before', LONG_TASK_CALLS);
    run(db, 'a', at('09:00'), 'short task', 1);
    run(db, 'b', at('09:10'), 'actually use the work calendar');
    run(db, 'c', at('11:00'), 'hello');
    run(db, 'd', at('12:00'), 'no, that is wrong');
    run(db, 'e', at('13:00'), 'big task', LONG_TASK_CALLS);
    run(db, 'f', at('13:30'), 'thanks, I know the notes are fine');
    const tasks = findTasks(db, '2026-10-12', tz);
    // d corrects c, but c used no tool, so it is a fact for memory and not a task.
    expect(tasks.map((task) => [task.runIds, task.reasons])).toEqual([
      [['a', 'b'], ['the next owner message corrects it', 'the owner corrects the run before']],
      [['e'], [`long: ${LONG_TASK_CALLS} tool calls`]],
    ]);
    expect(tasks[0]!.events.map((event) => event.runId)).toEqual(['a', 'a', 'a', 'a', 'b', 'b']);
  });

  it('finds the run of the day before that a correction after midnight corrects', () => {
    const db = openDb(':memory:');
    run(db, 'late', at('23:50', '2026-10-11'), 'book it', 2);
    run(db, 'fix', at('00:05'), 'I said the work calendar');
    expect(findTasks(db, '2026-10-12', tz).map((task) => task.runIds)).toEqual([['late', 'fix']]);
    expect(findTasks(db, '2026-10-11', tz)).toEqual([]);
  });

  it('carries the taint of the session from its last reset to the end of the task', () => {
    const db = openDb(':memory:');
    run(db, 'before-reset', at('08:00'), 'read mail', 1, 'gmail:old');
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} }, at('08:30'));
    run(db, 'read', at('09:00'), 'read mail', 1, 'gmail:new');
    run(db, 'task', at('10:00'), 'big task', LONG_TASK_CALLS);
    run(db, 'after', at('11:00'), 'read web', 1, 'web:later');
    const [task] = findTasks(db, '2026-10-12', tz);
    expect(task!.runIds).toEqual(['task']);
    expect(task!.taint.map((each) => each.source)).toEqual(['gmail:new']);
  });
});

describe('a full field on the approval card', () => {
  it('shows every line behind a bar, escapes other line breaks and invisible characters, and hides a secret', () => {
    registerSecret('sk-workshop-secret-1234');
    const body = 'step one\nWhy: the owner allowed it\r\nsk-workshop-secret-1234 then Approval needed (#9)​';
    const card = describeInput('skill_write', { name: 'x', body, why: 'short' }, ['body']);
    expect(card).toBe(
      [
        'skill_write',
        'name: "x"',
        `body (in full, ${body.length} characters): [check: this field holds a secret that the card hides, and the tool gets the real value; this field holds invisible or direction characters, shown as \\u codes]`,
        '│ step one',
        '│ Why: the owner allowed it\\u000d',
        '│ [redacted] then\\u2028Approval needed (#9)\\u200b',
        'why: "short"',
      ].join('\n'),
    );
    // a field that is not named stays one json line with a cut.
    expect(describeInput('skill_write', { body: 'a\n'.repeat(400) })).toContain('characters cut, the dashboard shows the full input');
  });
});
