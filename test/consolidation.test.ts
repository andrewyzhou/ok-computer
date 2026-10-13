import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addGoal, updateGoal } from '../src/goals/store.js';
import { CONSOLIDATION_INSTRUCTIONS, isoWeek, MEMORY_LIMIT } from '../src/memory/consolidate.js';
import { textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { createTestApp } from './app-harness.js';

const pdt = (time: string, day: string) => new Date(`${day}T${time}:00-07:00`);
const slots = { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, consolidation: { chain: ['fake/m'] } };

function setup(steps: FakeStep[]) {
  const t = createTestApp(steps, { start: pdt('09:00', '2026-10-12').toISOString(), config: { slots } });
  const memoryDir = join(t.dataDir, 'memory');
  // two days of goals. the database says 2 of 4 goals are done.
  const essay = addGoal(t.db, { day: '2026-10-11', title: 'essay', eta: pdt('21:00', '2026-10-11').toISOString() }, pdt('19:00', '2026-10-11'));
  updateGoal(t.db, essay.id, { status: 'done' }, pdt('20:30', '2026-10-11'));
  addGoal(t.db, { day: '2026-10-11', title: 'gym', eta: pdt('22:30', '2026-10-11').toISOString() }, pdt('19:00', '2026-10-11'));
  const read = addGoal(t.db, { day: '2026-10-12', title: 'read', eta: pdt('09:30', '2026-10-12').toISOString() }, pdt('08:00', '2026-10-12'));
  updateGoal(t.db, read.id, { status: 'done' }, pdt('10:00', '2026-10-12'));
  const call = addGoal(t.db, { day: '2026-10-12', title: 'call mom' }, pdt('08:00', '2026-10-12'));
  updateGoal(t.db, call.id, { status: 'dropped', note: 'too tired' }, pdt('23:00', '2026-10-12'));

  mkdirSync(join(memoryDir, 'daily'), { recursive: true });
  // the note claims a different count. the statistics must ignore it.
  writeFileSync(join(memoryDir, 'daily', '2026-10-12.md'), '# 2026-10-12\n\n## notes\n\nI did 10 of 10 goals! The owner started climbing.\n');
  writeFileSync(join(memoryDir, 'MEMORY.md'), 'The owner is vegetarian.\n');
  return { ...t, memoryDir };
}

const save = (input: Record<string, unknown>) =>
  toolStep({ id: `s${Math.random()}`, name: 'consolidation_save', input: { logNote: 'one new fact', weeklyTrends: '- mornings work best', ...input } });

describe('nightly consolidation', () => {
  it('writes the weekly stats from the database, keeps MEMORY.md under its limit, backs it up and logs', async () => {
    const t = setup([
      save({ memory: 'x'.repeat(MEMORY_LIMIT + 1) }),
      save({ memory: 'The owner is vegetarian.\nThe owner climbs.' }),
      textStep('NO_REPLY'),
    ]);
    await t.app.start();
    expect(t.rows("SELECT slot FROM automations WHERE json_extract(payload, '$.type') = 'consolidation'")).toEqual([
      { slot: 'consolidation' },
    ]);
    await t.at(pdt('03:00', '2026-10-13').toISOString());

    const first = t.model.calls[0]!;
    expect(first.system).toContain(CONSOLIDATION_INSTRUCTIONS);
    expect(first.tools.map((tool) => tool.name)).toEqual(['consolidation_save']);
    const input = JSON.stringify(first.messages);
    expect(input).toContain('Nightly memory consolidation for 2026-10-12.');
    expect(input).toContain('I did 10 of 10 goals!');
    expect(input).toContain('The current MEMORY.md (24 of 8000 characters):\\nThe owner is vegetarian.');
    expect(JSON.stringify(t.model.calls[1]!.messages)).toContain('the limit is 8000. Shorten the memory text');

    const week = isoWeek('2026-10-12');
    expect(week).toBe('2026-W42');
    const weekly = readFileSync(join(t.memoryDir, 'weekly', `${week}.md`), 'utf8');
    expect(weekly).toContain(
      '- last 7 days (2026-10-06 to 2026-10-12): 4 goals on 2 days, hit rate 50%, 2 done (1 on time), 1 dropped, 1 open. ' +
        'Streak of days with goals: 2. Streak of days with all goals done: 0.',
    );
    expect(weekly).toContain('- done goals by the time they were done (last 30 days): morning 1, afternoon 0, evening 1, night 0.');
    expect(weekly).toContain('- slipped or late goals by their eta (last 30 days): morning 1, afternoon 0, evening 0, night 1.');
    expect(weekly).toContain('## trends\n\n- mornings work best\n');

    expect(readFileSync(join(t.memoryDir, 'MEMORY.md'), 'utf8')).toBe('The owner is vegetarian.\nThe owner climbs.\n');
    expect(readFileSync(join(t.memoryDir, 'history', 'MEMORY.md.bak-2026-10-13'), 'utf8')).toBe('The owner is vegetarian.\n');
    expect(readFileSync(join(t.memoryDir, 'consolidation-log.md'), 'utf8')).toBe(
      [
        '- 2026-10-13 03:00: consolidated 2026-10-12 into weekly/2026-W42.md. MEMORY.md did not change, because the new text has 8001 characters and the limit is 8000. one new fact',
        '- 2026-10-13 03:00: consolidated 2026-10-12 into weekly/2026-W42.md. MEMORY.md changed from 24 to 42 characters. one new fact',
        '',
      ].join('\n'),
    );
    expect(t.rows("SELECT sessionKey, trigger, slot FROM runs WHERE sessionKey LIKE 'consolidate:%'")).toEqual([
      { sessionKey: 'consolidate:2026-10-13', trigger: 'consolidation', slot: 'consolidation' },
    ]);
    expect(
      t.rows(
        `SELECT r.status FROM automation_runs r JOIN automations a ON a.id = r.automationId
         WHERE json_extract(a.payload, '$.type') = 'consolidation'`,
      ),
    ).toEqual([{ status: 'completed' }]);
    await t.app.stop();
  });

  it('fails the job when the model does not save, and changes nothing', async () => {
    const t = setup([textStep('I am done.')]);
    await t.app.start();
    await t.at(pdt('03:00', '2026-10-13').toISOString());
    expect(
      t.rows(
        `SELECT r.status, r.error FROM automation_runs r JOIN automations a ON a.id = r.automationId
         WHERE json_extract(a.payload, '$.type') = 'consolidation'`,
      ),
    ).toEqual([{ status: 'failed', error: 'the model did not save the consolidation' }]);
    expect(readFileSync(join(t.memoryDir, 'MEMORY.md'), 'utf8')).toBe('The owner is vegetarian.\n');
    expect(existsSync(join(t.memoryDir, 'consolidation-log.md'))).toBe(false);
    expect(t.printed()).toBe('');
    await t.app.stop();
  });
});
