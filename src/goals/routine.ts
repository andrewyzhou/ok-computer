import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { appendDailyNote } from '../memory/daily.js';
import { createAutomation } from '../scheduler/store.js';
import { localTime } from '../time.js';
import { closeCheckins, listGoals, type Goal } from './store.js';

const INSTALLED = 'goals_routine_installed';

export const ASK_PROMPT =
  "It is time for the evening goals question. Ask the owner for today's three goals and an ETA for each. Keep it short and friendly. When the owner answers, save the goals with goals_set.";

export const REMIND_PROMPT =
  "The owner has not set today's goals yet. Send one short and polite reminder to share today's three goals, each with an ETA. Do not repeat an earlier reminder word for word.";

export function checkinPrompt(goal: Goal, timeZone: string): string {
  const eta = goal.eta ? ` (ETA ${localTime(new Date(goal.eta), timeZone)})` : '';
  return `Check in on goal #${goal.id} "${goal.title}"${eta}. Ask the owner if it is done. If it is done, call goal_update with status done. If it is not done yet, ask for a new ETA, then call goal_update with the new eta and the reason in the note. If the owner gives it up, use status dropped.`;
}

const daily = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
};

// the routine is installed one time only. after that the automations belong to the owner, who can change or
// delete them.
export function installRoutine(db: Db, config: Pick<Config, 'timeZone' | 'routine'>, now: Date): boolean {
  if (getSetting(db, INSTALLED)) return false;
  const tz = config.timeZone;
  const add = (name: string, time: string, payload: Parameters<typeof createAutomation>[1]['payload']) => {
    const created = createAutomation(
      db,
      { name, schedule: { kind: 'cron', expr: daily(time), tz }, payload, sessionMode: 'main', createdBy: 'system' },
      now,
      tz,
    );
    if (!created.ok) throw new Error(`the routine automation "${name}" is invalid: ${created.error}`);
  };
  add('goals: ask', config.routine.askAt, { type: 'agent', prompt: ASK_PROMPT, condition: 'no_goals_today' });
  for (const time of config.routine.reminders) {
    add(`goals: reminder ${time}`, time, { type: 'agent', prompt: REMIND_PROMPT, condition: 'no_goals_today' });
  }
  add('goals: results', config.routine.resultsAt, { type: 'goals_results' });
  setSetting(db, INSTALLED, true, now);
  return true;
}

// the results come from the database. a check-in without an answer at the end of the day becomes no_answer.
export function writeDayResults(db: Db, memoryDir: string, day: string, now: Date, timeZone: string): string {
  const goals = listGoals(db, day);
  closeCheckins(
    db,
    goals.map((goal) => goal.id),
    now,
  );
  const time = (iso: string | null) => (iso ? localTime(new Date(iso), timeZone) : undefined);
  const done = goals.filter((goal) => goal.status === 'done');
  const slipped = goals.filter((goal) => goal.status !== 'done');

  const lines = ['## goals', ''];
  if (!goals.length) lines.push('No goals were set today.');
  else {
    lines.push(`${done.length} of ${goals.length} goals done.`);
    for (const goal of goals) {
      const details = [
        goal.eta ? `eta ${time(goal.eta)}` : undefined,
        goal.completedAt ? `done ${time(goal.completedAt)}` : undefined,
      ].filter(Boolean);
      lines.push(`- [${goal.status}] ${goal.title}${details.length ? ` (${details.join(', ')})` : ''}`);
    }
  }
  if (done.length) lines.push('', '## done', '', ...done.map((goal) => `- ${goal.title}`));
  if (slipped.length) {
    lines.push('', '## slipped and why', '');
    for (const goal of slipped) {
      const state = goal.status === 'dropped' ? 'dropped' : 'still open at the end of the day';
      lines.push(`- ${goal.title}: ${state}.${goal.note ? ` Reason: ${goal.note}` : ''}`);
    }
  }
  const text = lines.join('\n');
  appendDailyNote(memoryDir, day, text);
  return text;
}
