import type { Result } from '../config/load.js';
import type { Db } from '../db/index.js';
import { addDays, localDay, localTime } from '../time.js';

export type GoalStatus = 'open' | 'done' | 'dropped';
export type CheckinAnswer = 'done' | 'not_yet' | 'dropped' | 'no_answer';

export interface Goal {
  id: number;
  day: string;
  title: string;
  eta: string | null;
  // the first eta that the goal got. the statistics count a goal as on time only when it was done by this time.
  firstEta: string | null;
  status: GoalStatus;
  createdAt: string;
  completedAt: string | null;
  note: string | null;
}

export interface GoalPatch {
  status?: GoalStatus;
  eta?: string;
  note?: string;
}

export function addGoal(db: Db, input: { day: string; title: string; eta?: string }, now: Date): Goal {
  const row = db
    .prepare('INSERT INTO goals (day, title, eta, firstEta, status, createdAt) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
    .get(input.day, input.title, input.eta ?? null, input.eta ?? null, 'open', now.toISOString());
  return toGoal(row!);
}

export function getGoal(db: Db, id: number): Goal | undefined {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  return row ? toGoal(row) : undefined;
}

export function listGoals(db: Db, from: string, to = from): Goal[] {
  return db.prepare('SELECT * FROM goals WHERE day BETWEEN ? AND ? ORDER BY day, id').all(from, to).map(toGoal);
}

// an update also answers the open check-in of the goal, so the check-in history shows what the owner said.
export function updateGoal(db: Db, id: number, patch: GoalPatch, now: Date): Result<Goal> {
  const goal = getGoal(db, id);
  if (!goal) return { ok: false, error: `no goal has the id ${id}` };
  const status = patch.status ?? goal.status;
  const completedAt = status === 'done' ? (goal.completedAt ?? now.toISOString()) : null;
  db.prepare('UPDATE goals SET status = ?, eta = ?, firstEta = ?, note = ?, completedAt = ? WHERE id = ?').run(
    status,
    patch.eta ?? goal.eta,
    goal.firstEta ?? patch.eta ?? null,
    patch.note ?? goal.note,
    completedAt,
    id,
  );
  const answer: CheckinAnswer | undefined =
    status === 'done' ? 'done' : status === 'dropped' ? 'dropped' : patch.eta ? 'not_yet' : undefined;
  if (answer) {
    db.prepare('UPDATE goal_checkins SET answer = ?, answeredAt = ? WHERE goalId = ? AND answer IS NULL').run(
      answer,
      now.toISOString(),
      id,
    );
  }
  return { ok: true, value: getGoal(db, id)! };
}

export function startCheckin(db: Db, goalId: number, now: Date): void {
  closeCheckins(db, [goalId], now);
  db.prepare('INSERT INTO goal_checkins (goalId, askedAt) VALUES (?, ?)').run(goalId, now.toISOString());
}

// a check-in without an answer gets no_answer when a new check-in starts or the day ends.
export function closeCheckins(db: Db, goalIds: number[], now: Date): void {
  const close = db.prepare("UPDATE goal_checkins SET answer = 'no_answer', answeredAt = ? WHERE goalId = ? AND answer IS NULL");
  for (const id of goalIds) close.run(now.toISOString(), id);
}

export function listCheckins(db: Db, goalId: number): Array<{ askedAt: string; answer: CheckinAnswer | null }> {
  return db
    .prepare('SELECT askedAt, answer FROM goal_checkins WHERE goalId = ? ORDER BY id')
    .all(goalId)
    .map((row) => ({ askedAt: String(row.askedAt), answer: (row.answer ?? null) as CheckinAnswer | null }));
}

export interface GoalStats {
  from: string;
  to: string;
  daysWithGoals: number;
  goals: number;
  done: number;
  doneOnTime: number;
  dropped: number;
  open: number;
  hitRate: number | null;
  setStreak: number;
  allDoneStreak: number;
}

// a streak counts back from the last day of the range. a last day without goals does not break the streak, because
// the owner can still set them.
export function goalStats(db: Db, from: string, to: string): GoalStats {
  const goals = listGoals(db, from, to);
  const byDay = new Map<string, Goal[]>();
  for (const goal of goals) byDay.set(goal.day, [...(byDay.get(goal.day) ?? []), goal]);
  const count = (status: GoalStatus) => goals.filter((goal) => goal.status === status).length;
  const done = count('done');

  const streak = (test: (day: Goal[]) => boolean) => {
    let day = byDay.has(to) ? to : addDays(to, -1);
    let n = 0;
    while (day >= from && byDay.has(day) && test(byDay.get(day)!)) {
      n++;
      day = addDays(day, -1);
    }
    return n;
  };

  return {
    from,
    to,
    daysWithGoals: byDay.size,
    goals: goals.length,
    done,
    doneOnTime: goals.filter((goal) => goal.status === 'done' && goal.firstEta && goal.completedAt! <= goal.firstEta).length,
    dropped: count('dropped'),
    open: count('open'),
    hitRate: goals.length ? Math.round((done / goals.length) * 100) / 100 : null,
    setStreak: streak(() => true),
    allDoneStreak: streak((day) => day.every((goal) => goal.status === 'done')),
  };
}

export function formatGoal(goal: Goal, timeZone: string): string {
  // an eta after midnight is on the next day, so it shows its date.
  const etaDay = goal.eta ? localDay(new Date(goal.eta), timeZone) : goal.day;
  const eta = goal.eta ? `, eta ${etaDay === goal.day ? '' : `${etaDay} `}${localTime(new Date(goal.eta), timeZone)}` : '';
  const note = goal.note ? ` (note: ${goal.note})` : '';
  return `#${goal.id} ${goal.title} [${goal.status}${eta}]${note}`;
}

function toGoal(row: Record<string, unknown>): Goal {
  return {
    id: Number(row.id),
    day: String(row.day),
    title: String(row.title),
    eta: row.eta === null ? null : String(row.eta),
    firstEta: row.firstEta === null || row.firstEta === undefined ? null : String(row.firstEta),
    status: row.status as GoalStatus,
    createdAt: String(row.createdAt),
    completedAt: row.completedAt === null ? null : String(row.completedAt),
    note: row.note === null ? null : String(row.note),
  };
}
