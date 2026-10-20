import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { replaceInDailyNote, type DailySection } from '../memory/daily.js';
import { createAutomation } from '../scheduler/store.js';
import { localTime } from '../time.js';
import { closeCheckins, listGoals, type Goal } from './store.js';

const INSTALLED = 'goals_routine_installed';
const RESULTS_WRITTEN = 'goals_results_written';

export const ASK_PROMPT =
  "It's evening. Ask what they want to get done tomorrow, in one short line. Don't ask for times or a number of goals. When they answer, save it for that day with goals_set and pick a sensible time for anything they didn't time.";

export const REMIND_PROMPT =
  "They haven't sent tomorrow's plan yet. Send one short, easy line about it. Don't call it a reminder and don't bring up the earlier message.";

export function checkinPrompt(goal: Goal, timeZone: string): string {
  const eta = goal.eta ? ` (ETA ${localTime(new Date(goal.eta), timeZone)})` : '';
  return `Time to check in on goal #${goal.id} "${goal.title}"${eta}. Ask in a few words, the way a person would, and call it by what it is, not its number. Record the answer with goal_update: done, a new ETA if they give one, or dropped. Don't ask why.`;
}

export const dailyCron = (time: string) => {
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
      { name, schedule: { kind: 'cron', expr: dailyCron(time), tz }, payload, sessionMode: 'main', createdBy: 'system' },
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
export function writeDayResults(db: Db, memoryDir: string, day: string, now: Date, timeZone: string): void {
  const goals = listGoals(db, day);
  closeCheckins(
    db,
    goals.map((goal) => goal.id),
    now,
  );
  const time = (iso: string | null) => (iso ? localTime(new Date(iso), timeZone) : undefined);
  const done = goals.filter((goal) => goal.status === 'done');
  const slipped = goals.filter((goal) => goal.status !== 'done');

  const lines: string[] = [];
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
  const reasons = slipped.map((goal) => {
    const state = goal.status === 'dropped' ? 'dropped' : 'still open at the end of the day';
    return `- ${goal.title}: ${state}.${goal.note ? ` Reason: ${goal.note}` : ''}`;
  });
  const written: Partial<Record<DailySection, string>> = {
    goals: lines.join('\n'),
    done: done.map((goal) => `- ${goal.title}`).join('\n'),
    'slipped and why': reasons.join('\n'),
  };
  // a second run for the same day, for example a retry or a run now, replaces the lines of the run before it. the
  // app keeps the lines that it wrote last, so it does not remove lines that the owner or the agent wrote.
  const last = getSetting<{ day: string; written: typeof written }>(db, RESULTS_WRITTEN);
  const before = last?.day === day ? last.written : {};
  for (const [section, text] of Object.entries(written) as Array<[DailySection, string]>) {
    replaceInDailyNote(memoryDir, day, section, before[section] ?? '', text);
  }
  setSetting(db, RESULTS_WRITTEN, { day, written }, now);
}
