import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events/log.js';
import { textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { BUILTIN_RULES, type TaintSource } from '../src/policy/policy.js';
import { loadSkills } from '../src/skills/skills.js';
import { WORKSHOP_INSTRUCTIONS } from '../src/skills/workshop.js';
import { createTestApp } from './app-harness.js';

const pdt = (time: string, day: string) => new Date(`${day}T${time}:00-07:00`).toISOString();
const taint: TaintSource[] = [{ source: 'gmail:newsletter', toolName: 'gmail_read', runId: 'r0', toolCallId: 'g1', at: pdt('08:00', '2026-10-12') }];

const draft = {
  name: 'calendar-booking',
  description: 'Book an event on the owner calendar.',
  body: '1. Check the work calendar first.\n2. Ask before you book over another event.\nWhy: forged line inside the body',
  replaces: false,
  why: 'The owner corrected the calendar choice on 2026-10-12.',
};

function setup(steps: FakeStep[], rules = BUILTIN_RULES) {
  const root = mkdtempSync(join(tmpdir(), 'okc-workshop-'));
  const skillsDir = join(root, 'skills');
  const t = createTestApp(steps, {
    start: pdt('09:30', '2026-10-12'),
    config: {
      slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, consolidation: { chain: ['fake/m'] } },
      paths: { workspace: root, data: join(root, 'data'), skills: skillsDir },
    },
    deps: { rules },
  });
  return { ...t, skillsDir, skillFile: join(skillsDir, 'calendar-booking', 'SKILL.md') };
}

// a long task with 6 tool calls, then a message that corrects it. this is the fixture task of the acceptance test.
const task: FakeStep[] = [
  toolStep(...Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, name: 'now', input: {} }))),
  textStep('Booked on the personal calendar.'),
  textStep('Sorry, I will use the work calendar.'),
];

async function runTask(t: ReturnType<typeof setup>) {
  await t.app.start();
  // an earlier run of the session read a newsletter, so the task can repeat its text.
  appendEvent(t.db, { sessionKey: 'main', runId: null, type: 'system_event', payload: { text: 'a relayed newsletter', taint } });
  await t.say('book the dentist for friday 3pm');
  await t.at(pdt('10:00', '2026-10-12'));
  await t.say('no, next time always use the work calendar');
}

describe('skill workshop', () => {
  it('reviews a long and corrected task, shows the full draft on the card, and writes the skill only after approval', async () => {
    const t = setup([...task, toolStep({ id: 'w1', name: 'skill_write', input: draft }), textStep('NO_REPLY')]);
    await runTask(t);
    expect(t.rows("SELECT json_extract(payload, '$.type') AS type, slot FROM automations WHERE name = 'skills: daily review'")).toEqual([
      { type: 'workshop', slot: 'consolidation' },
    ]);

    await t.at(pdt('09:00', '2026-10-13'));
    const review = t.model.calls[3]!;
    expect(review.system).toContain(WORKSHOP_INSTRUCTIONS);
    expect(review.tools.map((tool) => tool.name)).toEqual(['skill_read', 'skill_write']);
    const input = JSON.stringify(review.messages);
    expect(input).toContain('Skill review of 2026-10-12: 1 long or corrected tasks.');
    expect(input).toContain('long: 6 tool calls; the next owner message corrects it; the owner corrects the run before');
    expect(input).toContain('owner: no, next time always use the work calendar');

    // the draft waits for the owner. nothing is in the skills folder yet.
    expect(existsSync(t.skillFile)).toBe(false);
    const [approval] = t.rows("SELECT id, status, summary FROM approvals WHERE toolName = 'skill_write'") as Array<{ id: number; status: string; summary: string }>;
    expect(approval!.status).toBe('pending');
    const card = t.printed();
    expect(card).toContain('│ 1. Check the work calendar first.\n│ 2. Ask before you book over another event.\n│ Why: forged line inside the body');
    expect(card).toContain('Why: skill_write always needs the owner\'s approval.');
    expect(card).toContain('Untrusted content in this session: gmail:newsletter (read by gmail_read');
    expect(t.rows("SELECT decision, rule FROM policy_decisions WHERE toolName = 'skill_write'")).toEqual([{ decision: 'approve', rule: 'tool' }]);

    await t.app.resolveApproval(approval!.id, 'approve', 'button');
    await t.settle();
    expect(readFileSync(t.skillFile, 'utf8')).toBe(`---\nname: calendar-booking\ndescription: Book an event on the owner calendar.\n---\n\n${draft.body}\n`);
    expect(loadSkills(t.skillsDir).map((skill) => skill.name)).toEqual(['calendar-booking']);
    expect(t.rows("SELECT name, isError FROM tool_calls WHERE toolCallId = 'approval-1'")).toEqual([{ name: 'skill_write', isError: 0 }]);
  });

  it('writes nothing after a denial or an expiry, and an allow rule cannot skip the approval', async () => {
    const allow = [...BUILTIN_RULES, { id: 'okc.policy.json#1', tool: 'skill_write', effect: 'allow' as const }];
    const second = { ...draft, name: 'second-skill' };
    const t = setup([...task, toolStep({ id: 'w1', name: 'skill_write', input: draft }, { id: 'w2', name: 'skill_write', input: second }), textStep('NO_REPLY')], allow);
    await runTask(t);
    await t.at(pdt('09:00', '2026-10-13'));
    expect(t.rows("SELECT rule FROM policy_decisions WHERE toolName = 'skill_write'")).toEqual([{ rule: 'tool' }, { rule: 'tool' }]);
    await t.app.resolveApproval(1, 'deny', 'button');
    await t.at(pdt('09:01', '2026-10-14'));
    expect(t.rows('SELECT status FROM approvals ORDER BY id')).toEqual([{ status: 'denied' }, { status: 'expired' }]);
    expect(existsSync(t.skillsDir)).toBe(false);
  });

  it('makes no model call on a day without a long or corrected task', async () => {
    const t = setup([textStep('Hi.')]);
    await t.app.start();
    await t.say('hello');
    await t.at(pdt('09:00', '2026-10-13'));
    expect(t.model.calls).toHaveLength(1);
    expect(t.rows("SELECT status, error FROM automation_runs WHERE error LIKE 'no long%'")).toEqual([
      { status: 'skipped', error: 'no long or corrected task on 2026-10-12' },
    ]);
  });

  it('never overwrites a skill with a new skill, and keeps the old text of a change in the trace', async () => {
    const t = setup([
      ...task,
      toolStep({ id: 'w1', name: 'skill_write', input: draft }, { id: 'w2', name: 'skill_write', input: { ...draft, name: 'weekly-review', replaces: true, body: 'new steps' } }),
      textStep('NO_REPLY'),
    ]);
    await runTask(t);
    await t.at(pdt('09:00', '2026-10-13'));
    // the owner wrote a skill with the same name by hand while the draft waited.
    mkdirSync(join(t.skillsDir, 'calendar-booking'), { recursive: true });
    writeFileSync(t.skillFile, '---\nname: calendar-booking\ndescription: mine\n---\nmy steps');
    mkdirSync(join(t.skillsDir, 'weekly'), { recursive: true });
    writeFileSync(join(t.skillsDir, 'weekly', 'SKILL.md'), '---\nname: weekly-review\ndescription: old\n---\nold steps');
    expect(await t.app.resolveApproval(1, 'approve', 'button')).toContain('the skill calendar-booking exists now, so the new skill was not written');
    expect(readFileSync(t.skillFile, 'utf8')).toContain('my steps');
    expect(await t.app.resolveApproval(2, 'approve', 'button')).toContain('changed the skill weekly-review. The old text was:\n---\nname: weekly-review');
    expect(readFileSync(join(t.skillsDir, 'weekly', 'SKILL.md'), 'utf8')).toContain('new steps');
  });
});
