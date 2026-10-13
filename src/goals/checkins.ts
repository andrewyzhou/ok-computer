import type { Db } from '../db/index.js';
import { createAutomation } from '../scheduler/store.js';
import type { Goal } from './store.js';

// a goal has at most one planned check-in. a new eta replaces the old check-in.
export function planCheckin(db: Db, goal: Goal, now: Date, timeZone: string): void {
  db.prepare(
    `UPDATE automations SET enabled = 0, nextRunAt = NULL, updatedAt = ?
     WHERE enabled = 1 AND json_extract(payload, '$.type') = 'goal_checkin' AND json_extract(payload, '$.goalId') = ?`,
  ).run(now.toISOString(), goal.id);
  if (goal.status !== 'open' || !goal.eta || new Date(goal.eta) <= now) return;
  createAutomation(
    db,
    {
      name: `check-in: ${goal.title}`,
      schedule: { kind: 'at', at: goal.eta },
      payload: { type: 'goal_checkin', goalId: goal.id },
      sessionMode: 'main',
      createdBy: 'system',
    },
    now,
    timeZone,
  );
}
