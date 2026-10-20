import type { Hono } from 'hono';
import { z } from 'zod';
import { findConflicts, findTravelGaps, unansweredInvites } from '../brief/analyze.js';
import { settleApprovals } from '../inbox/actions.js';
import { listProposals } from '../inbox/views.js';
import { addDays, localDay, zonedToUtc } from '../time.js';
import type { CalendarPage, CalendarProposalBlock } from './calendar-types.js';
import { isDay, limitOf } from './params.js';
import type { DashboardDeps } from './server.js';
import type { CalendarProposalView } from './types.js';

// phase 6 t1 (the today track) owns this module. it mounts GET /api/calendar for the calendar page. docs/API.md (t1)
// gives the shape and the errors, and the types are in calendar-types.ts. server.ts calls it after the sign-in check.

// a proposal of a timed event without an end covers this long on the grid.
const OPEN_PROPOSAL_MS = 30 * 60_000;

// the first sentence that zod gives, which the page can show.
const firstError = (error: z.ZodError) => error.issues[0]?.message ?? 'the request is not valid';

const calendarQuery = z.object({
  from: z
    .string()
    .optional()
    .refine((value) => value === undefined || isDay(value), 'give from as yyyy-mm-dd'),
  // days is cut to 1 to 14, and a value that is not a number gives 7.
  days: z
    .string()
    .optional()
    .transform((raw) => limitOf(raw, 14, 7)),
});

// the time that a proposal covers, in ms. an all-day proposal stores a day or an iso time, and covers that local day.
// a timed one covers startAt to endAt, or 30 minutes without an end. a proposal whose times cannot be read covers
// nothing, so it is left out.
function spanOf(proposal: CalendarProposalView, timeZone: string): { start: number; end: number } | undefined {
  if (proposal.allDay) {
    const day = isDay(proposal.startAt) ? proposal.startAt : Number.isFinite(Date.parse(proposal.startAt)) ? localDay(new Date(proposal.startAt), timeZone) : undefined;
    if (day === undefined) return undefined;
    return { start: zonedToUtc(day, '00:00', timeZone).getTime(), end: zonedToUtc(addDays(day, 1), '00:00', timeZone).getTime() };
  }
  const start = Date.parse(proposal.startAt);
  if (!Number.isFinite(start)) return undefined;
  const end = proposal.endAt === null ? start + OPEN_PROPOSAL_MS : Date.parse(proposal.endAt);
  return Number.isFinite(end) ? { start, end: Math.max(start, end) } : undefined;
}

export function mountCalendar(server: Hono, deps: DashboardDeps): void {
  const { db, app, clock } = deps;
  const tz = deps.config.timeZone;

  server.get('/api/calendar', async (c) => {
    const parsed = calendarQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const now = clock();
    const from = parsed.data.from ?? localDay(now, tz);
    const days = Array.from({ length: parsed.data.days }, (_, index) => addDays(from, index));
    const startAt = zonedToUtc(from, '00:00', tz);
    const endAt = zonedToUtc(addDays(from, parsed.data.days), '00:00', tz);

    // an error here is not an account that failed, because those are in skipped, so it falls to onError and gives 500.
    const read = await app.today.calendar({ startAt, endAt });
    const events = [...read.events].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.key.localeCompare(b.key));

    // a denied or expired approval declines or expires its proposal here, as on the inbox page.
    settleApprovals(db, now);
    const proposals: Array<CalendarProposalBlock & { order: number }> = [];
    for (const proposal of listProposals(db, { state: 'proposed', limit: 200 })) {
      const span = spanOf(proposal, tz);
      if (!span) continue;
      // an event of no length touches the range when it is in it.
      const touches = span.start < endAt.getTime() && (span.end > startAt.getTime() || span.start >= startAt.getTime());
      if (!touches) continue;
      proposals.push({
        proposalId: proposal.id,
        account: proposal.account,
        title: proposal.title,
        kind: proposal.kind,
        startAt: proposal.startAt,
        endAt: proposal.endAt,
        allDay: proposal.allDay,
        approvalId: proposal.approvalId,
        order: span.start,
      });
    }
    proposals.sort((a, b) => a.order - b.order || a.proposalId - b.proposalId);

    const page: CalendarPage = {
      configured: read.configured,
      timeZone: tz,
      from,
      to: days.at(-1) ?? from,
      days,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      calendars: read.calendars,
      events,
      proposals: proposals.map(({ order: _order, ...block }) => block),
      conflicts: findConflicts(events),
      travelGaps: findTravelGaps(events),
      invites: unansweredInvites(events, now).map((event) => event.key),
      skipped: read.skipped,
    };
    return c.json(page);
  });
}
