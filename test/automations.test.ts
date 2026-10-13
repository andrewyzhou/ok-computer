import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/events/log.js';
import { textStep, toolStep } from '../src/models/fake.js';
import { createTestApp } from './app-harness.js';

const pdt = (time: string, day = '2026-10-12') => new Date(`${day}T${time}:00-07:00`).toISOString();

describe('automations from chat', () => {
  it('creates an isolated automation, runs it at its time, and sends its text to the owner', async () => {
    const t = createTestApp(
      [
        toolStep({
          id: 'a1',
          name: 'automations_create',
          input: {
            name: 'water',
            schedule: { kind: 'cron', expr: '0 10 * * *' },
            payload: { type: 'agent', prompt: 'Remind the owner to drink water.' },
          },
        }),
        textStep('Done. I will remind you at 10:00 each day.'),
        textStep('Time to drink some water.'),
        textStep('NO_REPLY'),
      ],
      { start: pdt('09:00') },
    );
    await t.app.start();
    await t.say('remind me to drink water every day at 10am');
    expect(t.printed()).toContain('okc> Done. I will remind you at 10:00 each day.');
    const [water] = t.rows("SELECT id, createdBy, sessionMode, nextRunAt FROM automations WHERE name = 'water'");
    expect(water).toMatchObject({ createdBy: 'agent', sessionMode: 'isolated', nextRunAt: '2026-10-12T17:00:00.000Z' });

    await t.at(pdt('10:00'));
    expect(t.printed()).toContain('okc> Time to drink some water.');
    const isolated = t.model.calls[2]!;
    expect(isolated.tools.map((tool) => tool.name)).toContain('message_owner');
    expect(isolated.tools.map((tool) => tool.name)).not.toContain('automations_delete');
    expect(isolated.messages).toHaveLength(1);
    expect(t.rows('SELECT sessionKey, trigger FROM runs ORDER BY rowid').at(-1)).toEqual({
      sessionKey: `auto:${water!.id}:run-2`,
      trigger: 'automation',
    });
    expect(listEvents(t.db, 'main').at(-1)).toMatchObject({
      type: 'system_event',
      payload: { text: 'The automation "water" sent this message to the owner:\nTime to drink some water.' },
    });

    // a NO_REPLY result sends nothing and adds nothing to the main session.
    const before = t.printed();
    await t.at(pdt('10:00', '2026-10-13'));
    expect(t.printed()).toBe(before);
    expect(listEvents(t.db, 'main').filter((e) => e.type === 'system_event')).toHaveLength(1);
    await t.app.stop();
  });

  it('adds a system event to the main session without a model call', async () => {
    const t = createTestApp(
      [
        toolStep({
          id: 'a1',
          name: 'automations_create',
          input: {
            name: 'note',
            schedule: { kind: 'at', at: '2026-10-12T12:00:00-07:00' },
            payload: { type: 'system_event', text: 'The owner wanted to call mom today.' },
          },
        }),
        textStep('Noted.'),
      ],
      { start: pdt('09:00') },
    );
    await t.app.start();
    await t.say('note that I want to call mom at noon');
    await t.at(pdt('12:00'));
    expect(t.model.calls).toHaveLength(2);
    expect(listEvents(t.db, 'main').at(-1)).toMatchObject({
      type: 'system_event',
      payload: { text: 'Automation "note": The owner wanted to call mom today.' },
    });
    expect(t.rows("SELECT enabled FROM automations WHERE name = 'note'")).toEqual([{ enabled: 0 }]);
    await t.app.stop();
  });

  it('lists automations with their schedules in plain words', async () => {
    const t = createTestApp(
      [
        toolStep({ id: 'l1', name: 'automations_list', input: {} }),
        textStep('Here they are.'),
      ],
      { start: pdt('09:00') },
    );
    await t.app.start();
    await t.say('what automations do I have?');
    const row = t.rows("SELECT output FROM tool_calls WHERE name = 'automations_list'")[0]!;
    const listed = JSON.parse(String(row.output)).content as string;
    expect(listed).toContain('"goals: ask": every day at 19:00, cron "0 19 * * *" (America/Los_Angeles), next Monday, October 12, 2026 at 19:00 PDT');
    await t.app.stop();
  });
});
