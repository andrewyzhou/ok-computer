import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { textStep, toolStep } from '../src/models/fake.js';
import { createTestApp } from './app-harness.js';

// the times are in the owner's time zone, america/los_angeles, which is utc-7 in october.
const pdt = (time: string, day = '2026-10-12') => new Date(`${day}T${time}:00-07:00`).toISOString();

describe('the evening goals routine', () => {
  it('asks, reminds, saves goals, checks in at each eta, and writes the results to the daily note', async () => {
    const t = createTestApp(
      [
        textStep('What are your three goals for today, each with an ETA?'),
        textStep('Friendly reminder: what are your three goals today?'),
        toolStep({
          id: 'g1',
          name: 'goals_set',
          input: { goals: [{ title: 'finish essay', eta: '21:00' }, { title: 'gym', eta: '22:30' }, { title: 'read' }] },
        }),
        textStep('Saved your three goals.'),
        textStep('Is the essay done?'),
        toolStep({ id: 'g2', name: 'goal_update', input: { id: 1, eta: '21:30', note: 'started late' } }),
        textStep('OK, I will check again at 21:30.'),
        textStep('How about the essay now?'),
        toolStep({ id: 'g3', name: 'goal_update', input: { id: 1, status: 'done' } }),
        textStep('Great work.'),
        textStep('Did you go to the gym?'),
      ],
      { start: pdt('18:00') },
    );
    await t.app.start();
    expect(t.rows("SELECT name FROM automations WHERE name LIKE 'goals: %' ORDER BY name").map((r) => r.name)).toEqual([
      'goals: ask',
      'goals: reminder 20:00',
      'goals: reminder 21:00',
      'goals: reminder 22:00',
      'goals: results',
    ]);

    await t.at(pdt('19:00'));
    expect(t.printed()).toContain('okc> What are your three goals for today, each with an ETA?');
    await t.at(pdt('20:00'));
    expect(t.printed()).toContain('okc> Friendly reminder');

    await t.say('essay by 21:00, gym at 22:30, and read');
    expect(t.printed()).toContain('okc> Saved your three goals.');
    const afterSave = t.model.calls[3]!;
    expect(JSON.stringify(afterSave.messages)).toContain('#1 finish essay [open, eta 21:00]');

    // the reminder at 21:00 stops without a model call, and the essay check-in runs at the same time.
    await t.at(pdt('21:00'));
    expect(t.printed()).toContain('okc> Is the essay done?');
    expect(JSON.stringify(t.model.calls[4]!.messages.at(-1))).toContain('check in on goal #1 \\"finish essay\\" (ETA 21:00)');
    await t.say('not yet, give me until 21:30');
    expect(t.printed()).toContain('okc> OK, I will check again at 21:30.');

    await t.at(pdt('21:30'));
    expect(t.printed()).toContain('okc> How about the essay now?');
    await t.say('done!');
    await t.at(pdt('22:00'));
    await t.at(pdt('22:30'));
    expect(t.printed()).toContain('okc> Did you go to the gym?');
    await t.at(pdt('23:45'));

    expect(t.model.calls).toHaveLength(11);
    expect(
      t.rows(
        `SELECT a.name, r.status FROM automation_runs r JOIN automations a ON a.id = r.automationId
         WHERE a.name LIKE 'goals: %' ORDER BY r.id`,
      ),
    ).toEqual([
      { name: 'goals: ask', status: 'completed' },
      { name: 'goals: reminder 20:00', status: 'completed' },
      { name: 'goals: reminder 21:00', status: 'skipped' },
      { name: 'goals: reminder 22:00', status: 'skipped' },
      { name: 'goals: results', status: 'completed' },
    ]);
    expect(t.rows('SELECT goalId, answer FROM goal_checkins ORDER BY id')).toEqual([
      { goalId: 1, answer: 'not_yet' },
      { goalId: 1, answer: 'done' },
      { goalId: 2, answer: 'no_answer' },
    ]);

    const note = readFileSync(join(t.dataDir, 'memory', 'daily', '2026-10-12.md'), 'utf8');
    expect(note).toBe(
      [
        '# 2026-10-12',
        '',
        '## goals',
        '',
        '1 of 3 goals done.',
        '- [done] finish essay (eta 21:30, done 21:30)',
        '- [open] gym (eta 22:30)',
        '- [open] read',
        '',
        '## done',
        '',
        '- finish essay',
        '',
        '## slipped and why',
        '',
        '- gym: still open at the end of the day.',
        '- read: still open at the end of the day.',
        '',
        '',
      ].join('\n'),
    );
    await t.app.stop();
  });

  it('does not ask or remind when the goals for today are already set', async () => {
    const t = createTestApp(
      [toolStep({ id: 'g1', name: 'goals_set', input: { goals: [{ title: 'ship m2' }] } }), textStep('Saved.')],
      { start: pdt('09:00') },
    );
    await t.app.start();
    await t.say('today I will ship m2');
    for (const time of ['19:00', '20:00', '21:00', '22:00']) await t.at(pdt(time));
    expect(t.model.calls).toHaveLength(2);
    await t.app.stop();
  });

  it('installs the routine only one time, so the owner can delete parts of it', async () => {
    const t = createTestApp([], { start: pdt('09:00') });
    await t.app.start();
    t.db.prepare("DELETE FROM automations WHERE name = 'goals: reminder 22:00'").run();
    await t.app.stop();
    await t.app.start();
    expect(t.rows("SELECT COUNT(*) AS n FROM automations WHERE name LIKE 'goals: %'")).toEqual([{ n: 4 }]);
    await t.app.stop();
  });
});
