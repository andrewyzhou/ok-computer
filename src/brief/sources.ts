import type { BriefDelegation, BriefSources } from '../dashboard/brief-types.js';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import type { CalendarProposalView, GoalRow, InboxDigest } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { listGoals } from '../goals/store.js';
import { getDigest, listProposals } from '../inbox/views.js';
import { addDays, zonedToUtc } from '../time.js';
import { LOOKAHEAD_DAYS, type BriefInput } from './build.js';
import { readCalendar, type CalendarRead } from './calendar.js';
import type { BriefContext } from './context.js';
import { readDelegations } from './desk.js';

// the sources of a brief: the calendar, the inbox digest, the calendar proposals, the delegations and the goals.

// the id of the newest digest of one day, or undefined.
export function digestOfDay(db: Db, day: string): number | undefined {
  const row = db.prepare('SELECT id FROM inbox_digests WHERE day = ? ORDER BY id DESC LIMIT 1').get(day);
  return row ? Number(row.id) : undefined;
}

// the digest of the brief: the newest digest of the day, else the newest digest of the day before, else null.
export function digestForBrief(db: Db, day: string): InboxDigest | null {
  for (const each of [day, addDays(day, -1)]) {
    const id = digestOfDay(db, each);
    if (id !== undefined) return getDigest(db, id) ?? null;
  }
  return null;
}

// the aliases of the google accounts that the brief tries to read. without a google block there are none.
export const calendarAliases = (ctx: Pick<BriefContext, 'google'>): string[] => ctx.google?.accounts.aliases ?? [];

// the state of the calendar source: off without a google block, failed when every account was skipped, partial when
// some were or when one calendar of an account was not read in full, and ok otherwise.
function calendarState(ctx: Pick<BriefContext, 'google'>, read: CalendarRead): BriefSources['calendar'] {
  if (!read.configured) return 'off';
  const aliases = calendarAliases(ctx);
  const skipped = new Set(read.skipped.filter((each) => each.calendarId === undefined).map((each) => each.account));
  if (aliases.length && aliases.every((alias) => skipped.has(alias))) return 'failed';
  return read.skipped.length ? 'partial' : 'ok';
}

const toGoalRow = (goal: ReturnType<typeof listGoals>[number]): GoalRow => ({
  id: goal.id,
  day: goal.day,
  title: goal.title,
  eta: goal.eta,
  status: goal.status,
  completedAt: goal.completedAt,
  note: goal.note,
});

// gatherBriefInput reads every source for the day. a source that fails gives an empty part and a note in sources, so
// one broken source never stops the brief.
export async function gatherBriefInput(ctx: BriefContext, day: string): Promise<BriefInput> {
  const { db, logger, timeZone } = ctx;
  const failed = (source: string, err: unknown) => logger.error('a source of the brief failed', { source, day, err });

  let events: CalendarEvent[] = [];
  let calendar: BriefSources['calendar'] = 'off';
  let skipped: BriefSources['skipped'] = [];
  try {
    const read = await readCalendar(ctx, {
      startAt: zonedToUtc(day, '00:00', timeZone),
      endAt: zonedToUtc(addDays(day, LOOKAHEAD_DAYS + 1), '00:00', timeZone),
    });
    events = read.events;
    calendar = calendarState(ctx, read);
    skipped = read.skipped.map((each) => ({ account: each.account, reason: each.reason, ...(each.calendarId !== undefined ? { calendarId: each.calendarId } : {}) }));
  } catch (err) {
    failed('calendar', err);
    // without a google block there is no calendar to fail. with one, each account counts as not read.
    if (ctx.google) {
      calendar = 'failed';
      skipped = calendarAliases(ctx).map((account) => ({ account, reason: 'The calendar could not be read.' }));
    }
  }

  let digest: InboxDigest | null = null;
  try {
    digest = digestForBrief(db, day);
  } catch (err) {
    failed('digest', err);
  }

  let proposals: CalendarProposalView[] = [];
  try {
    proposals = listProposals(db, { state: 'proposed', limit: 50 });
  } catch (err) {
    failed('proposals', err);
  }

  // readDelegations never throws: a missing or broken desk module gives null.
  const delegations: BriefDelegation[] | null = await readDelegations(db, new Date(zonedToUtc(addDays(day, 1), '00:00', timeZone).getTime() - 1));

  let goals: GoalRow[] = [];
  try {
    goals = listGoals(db, day).map(toGoalRow);
  } catch (err) {
    failed('goals', err);
  }

  return {
    day,
    timeZone,
    now: ctx.clock(),
    events,
    sources: { calendar, skipped, digest: digest ? { id: digest.id, day: digest.day } : null, desk: delegations !== null },
    digest,
    proposals,
    delegations,
    goals,
  };
}
