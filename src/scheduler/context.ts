import type { Db } from '../db/index.js';
import { formatGoal, listGoals } from '../goals/store.js';
import { formatLocal, localDay } from '../time.js';

// the heartbeat is not in the list, because it runs all day and is not a plan of the owner.
export function scheduleContext(db: Db, now: Date, timeZone: string): string {
  const today = localDay(now, timeZone);
  const goals = listGoals(db, today);
  const next = db
    .prepare(
      `SELECT id, name, nextRunAt, taint IS NOT NULL AS tainted FROM automations
       WHERE enabled = 1 AND nextRunAt IS NOT NULL AND json_extract(payload, '$.type') != 'heartbeat'
       ORDER BY nextRunAt LIMIT 3`,
    )
    .all();
  const goalLines = goals.length ? goals.map((goal) => `- ${formatGoal(goal, timeZone)}`) : ['- none set yet'];
  // this context is in every run and carries no taint. the name of a tainted automation can repeat untrusted text,
  // so the line leaves it out. automations_list shows it as untrusted.
  const nextLines = next.length
    ? next.map((row) => {
        const name = row.tainted ? 'an automation whose name came from a session with untrusted content' : String(row.name);
        return `- ${formatLocal(new Date(String(row.nextRunAt)), timeZone)}: ${name} (${row.id})`;
      })
    : ['- none'];
  return [`today's goals (${today}):`, ...goalLines, 'next automations:', ...nextLines].join('\n');
}
