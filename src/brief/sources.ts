import type { BriefDelegation, BriefSources } from '../dashboard/brief-types.js';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import type { BriefInbox } from '../dashboard/inbox-types.js';
import type { CalendarProposalView, GoalRow } from '../dashboard/types.js';
import { listGoals } from '../goals/store.js';
import { inboxForBrief } from '../inbox/brief.js';
import { listProposals } from '../inbox/views.js';
import { findPersonByEmail } from '../people/index.js';
import { addDays, zonedToUtc } from '../time.js';
import { LOOKAHEAD_DAYS, type BriefInput } from './build.js';
import { readCalendar, type CalendarRead } from './calendar.js';
import type { BriefContext } from './context.js';
import { readDelegations } from './desk.js';

// the sources of a brief: the calendar, the inbox digest, the calendar proposals, the delegations and the goals. the
// digest comes through the read api of the inbox (src/inbox/brief.ts) and the delegations through the one of the desk
// (src/desk/index.ts), so the brief has no sql of the tables of other tracks.

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

// the names that the people memory has for the organizers of the events that the calendar gave only as an address. a
// meeting-only person has no name either, so a miss is normal and the brief then shows the address.
function namesOfOrganizers(db: BriefContext['db'], events: CalendarEvent[], now: Date): Record<string, string> {
  const names: Record<string, string> = {};
  const seen = new Set<string>();
  for (const event of events) {
    const address = event.organizer?.toLowerCase();
    if (event.organizerSelf || !address || !address.includes('@') || seen.has(address)) continue;
    seen.add(address);
    const name = findPersonByEmail(db, address, now)?.name;
    if (name) names[address] = name;
  }
  return names;
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

  let inbox: BriefInbox | null = null;
  try {
    inbox = inboxForBrief(db, day, ctx.google ? calendarAliases(ctx) : undefined);
  } catch (err) {
    failed('digest', err);
  }

  let proposals: CalendarProposalView[] = [];
  try {
    proposals = listProposals(db, { state: 'proposed', limit: 50 });
  } catch (err) {
    failed('proposals', err);
  }

  // a desk that cannot be read gives null, so the page does not claim that nothing waits.
  let delegations: BriefDelegation[] | null = null;
  try {
    delegations = readDelegations(db, new Date(zonedToUtc(addDays(day, 1), '00:00', timeZone).getTime() - 1), ctx.clock());
  } catch (err) {
    failed('desk', err);
  }

  let goals: GoalRow[] = [];
  try {
    goals = listGoals(db, day).map(toGoalRow);
  } catch (err) {
    failed('goals', err);
  }

  let organizerNames: Record<string, string> = {};
  try {
    organizerNames = namesOfOrganizers(db, events, ctx.clock());
  } catch (err) {
    failed('people', err);
  }

  return {
    day,
    timeZone,
    now: ctx.clock(),
    events,
    organizerNames,
    sources: { calendar, skipped, digest: inbox ? { id: inbox.digestId, day: inbox.day } : null, desk: delegations !== null },
    inbox,
    proposals,
    delegations,
    goals,
  };
}
