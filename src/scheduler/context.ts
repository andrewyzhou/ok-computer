import type { Db } from '../db/index.js';
import { formatGoal, listGoals } from '../goals/store.js';
import { formatLocal, localDay } from '../time.js';

// the heartbeat is not in the list, because it runs all day and is not a plan of the owner.
export function scheduleContext(db: Db, now: Date, timeZone: string): string {
  const today = localDay(now, timeZone);
  const goals = listGoals(db, today);
  const next = db
    .prepare(
      `SELECT id, name, nextRunAt FROM automations
       WHERE enabled = 1 AND nextRunAt IS NOT NULL AND json_extract(payload, '$.type') != 'heartbeat'
       ORDER BY nextRunAt LIMIT 3`,
    )
    .all();
  const goalLines = goals.length ? goals.map((goal) => `- ${formatGoal(goal, timeZone)}`) : ['- none set yet'];
  const nextLines = next.length
    ? next.map((row) => `- ${formatLocal(new Date(String(row.nextRunAt)), timeZone)}: ${row.name} (${row.id})`)
    : ['- none'];
  return [`today's goals (${today}):`, ...goalLines, 'next automations:', ...nextLines].join('\n');
}
