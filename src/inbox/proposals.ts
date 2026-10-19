import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CalendarProposalView } from '../dashboard/types.js';
import { getSetting, setSetting } from '../db/settings.js';
import { toGoogleError } from '../google/errors.js';
import { failed } from '../google/send.js';
import { requestContext } from '../google/trace.js';
import { cleanLine } from '../signals/store.js';
import { headOf } from '../text.js';
import { addDays, localDay, zonedToUtc } from '../time.js';
import { defineTool, type Tool, type ToolOutput } from '../tools/registry.js';
import { callTool } from './actions.js';
import type { InboxContext, JobRun } from './context.js';

// calendar proposals: the digest proposes an event for each course or bill deadline. the proposal is an approval of
// the inbox_create_event call, and the event is made only after the owner approves it.

export const EVENT_TOOL = 'inbox_create_event';

// a deadline that the digest found. the times are iso with an offset. an all-day event has startAt at midnight in the
// time zone of the app, and endAt null.
export type ProposalInput = Pick<CalendarProposalView, 'account' | 'kind' | 'title' | 'startAt' | 'endAt' | 'allDay' | 'description' | 'sourceMessageId' | 'sourceSubject'>;

const DAY_MS = 24 * 60 * 60 * 1000;
// a deadline more than a year ahead is more likely a wrong date than a plan.
const HORIZON_MS = 365 * DAY_MS;
// a timed deadline without an end gets a short event.
const DEFAULT_LENGTH_MS = 30 * 60 * 1000;
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 2000;

// the titles of two events are the same when they differ only in case and spaces.
const sameTitle = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

// the id of the event of a proposal comes from the proposal, so a second run of the approved call finds the first
// event (409) instead of making a copy. hex digits are valid base32hex, which google needs for an event id. the id
// hashes the account and the deadline with a random salt of this install, not the row id: row ids start again after a
// reset of the database, and a second install on the same account has rows of its own.
export const eventIdOf = (salt: string, account: string, dedupeKey: string) =>
  `okc${createHash('sha256').update(`inbox-proposal:${salt}:${account}:${dedupeKey}`).digest('hex').slice(0, 32)}`;

const SALT = 'inbox_event_salt';

// the salt of this install. the first proposal makes it.
export function eventSalt(ctx: Pick<InboxContext, 'db' | 'clock'>): string {
  const salt = getSetting<string>(ctx.db, SALT);
  if (salt) return salt;
  const made = randomBytes(16).toString('hex');
  setSetting(ctx.db, SALT, made, ctx.clock());
  return made;
}

interface ProposalRow {
  id: number;
  account: string;
  kind: string;
  title: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  description: string | null;
  state: string;
  eventId: string | null;
  dedupeKey: string;
}

function proposalRow(ctx: InboxContext, id: number): ProposalRow | undefined {
  const row = ctx.db.prepare('SELECT id, account, kind, title, startAt, endAt, allDay, description, state, eventId, dedupeKey FROM inbox_proposals WHERE id = ?').get(id);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    account: String(row.account),
    kind: String(row.kind),
    title: String(row.title),
    startAt: String(row.startAt),
    endAt: row.endAt === null ? null : String(row.endAt),
    allDay: Number(row.allDay) === 1,
    description: row.description === null ? null : String(row.description),
    state: String(row.state),
    eventId: row.eventId === null ? null : String(row.eventId),
    dedupeKey: String(row.dedupeKey),
  };
}

// proposeEvent gives the inbox_proposals row id, or null when no proposal was made (a past time, or an event of the
// same day and title on the calendar). a proposal of the same mail, kind and start gives the old row id again.
export async function proposeEvent(ctx: InboxContext, run: JobRun, p: ProposalInput): Promise<number | null> {
  const now = ctx.clock();
  const start = Date.parse(p.startAt);
  if (Number.isNaN(start) || start > now.getTime() + HORIZON_MS) return null;
  // an all-day deadline of today starts at midnight, before now, and it is still due until its day ends. so an
  // all-day start is compared by its local day.
  const past = p.allDay ? localDay(new Date(start), ctx.timeZone) < localDay(now, ctx.timeZone) : start < now.getTime();
  if (past) return null;
  const startAt = new Date(start).toISOString();
  let endAt: string | null = null;
  if (!p.allDay) {
    const end = p.endAt === null ? NaN : Date.parse(p.endAt);
    // an end that does not parse, or that is not after the start, is a wrong fact, so the default length is used.
    endAt = new Date(Number.isNaN(end) || end <= start ? start + DEFAULT_LENGTH_MS : end).toISOString();
  }
  const dedupeKey = `${p.sourceMessageId ?? 'none'}:${p.kind}:${startAt}`;
  const old = ctx.db.prepare('SELECT id FROM inbox_proposals WHERE account = ? AND dedupeKey = ?').get(p.account, dedupeKey);
  if (old) return Number(old.id);
  const title = cleanLine(p.title, TITLE_LIMIT);
  if (!title) return null;

  // the owner may have the deadline on the calendar already. the check looks at the local day of the start.
  const day = localDay(new Date(start), ctx.timeZone);
  try {
    const { data } = await ctx.google.accounts.run(p.account, (apis) =>
      apis.calendar.events.list({
        calendarId: 'primary',
        timeMin: zonedToUtc(day, '00:00', ctx.timeZone).toISOString(),
        timeMax: zonedToUtc(addDays(day, 1), '00:00', ctx.timeZone).toISOString(),
        singleEvents: true,
        maxResults: 250,
      }),
    );
    if ((data.items ?? []).some((event) => event.status !== 'cancelled' && sameTitle(event.summary ?? '') === sameTitle(title))) return null;
  } catch (err) {
    // without the check a proposal could repeat an event, so none is made now. the next digest tries again, because
    // no row was written.
    ctx.logger.warn('the inbox proposal could not read the calendar', { account: p.account, err: toGoogleError(err).message });
    return null;
  }

  const description = p.description ? headOf(p.description, DESCRIPTION_LIMIT) : null;
  const inserted = ctx.db
    .prepare(
      `INSERT INTO inbox_proposals (account, calendarId, kind, title, startAt, endAt, allDay, description, sourceMessageId, sourceSubject, dedupeKey, state, runId, createdAt)
       VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(
      p.account,
      p.kind,
      title,
      startAt,
      endAt,
      p.allDay ? 1 : 0,
      description,
      p.sourceMessageId,
      p.sourceSubject === null ? null : cleanLine(p.sourceSubject, 500),
      dedupeKey,
      run.runId,
      now.toISOString(),
    );
  const proposalId = Number(inserted.lastInsertRowid);
  const { output, approvalId } = await callTool(ctx, run, EVENT_TOOL, { proposalId, account: p.account, kind: p.kind, title, startAt, endAt, allDay: p.allDay, description });
  if (approvalId === null) {
    // the call did not ask the owner, so the policy refused it, and no event will come.
    ctx.db.prepare("UPDATE inbox_proposals SET state = 'failed', error = ?, resolvedAt = ? WHERE id = ?").run(output.content, ctx.clock().toISOString(), proposalId);
  } else {
    ctx.db.prepare('UPDATE inbox_proposals SET approvalId = ? WHERE id = ?').run(approvalId, proposalId);
  }
  return proposalId;
}

// the tool that makes an approved event: inbox_create_event.
export function createProposalTools(ctx: InboxContext): Tool[] {
  const aliases = ctx.googleConfig.accounts.map((each) => each.alias) as [string, ...string[]];
  const input = z.object({
    proposalId: z.number().int().positive(),
    account: z.enum(aliases).describe('the alias of the google account'),
    kind: z.enum(['course', 'bill', 'other']),
    title: z.string().min(1).max(TITLE_LIMIT),
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }).nullable(),
    allDay: z.boolean(),
    description: z.string().max(DESCRIPTION_LIMIT).nullable(),
  });
  type Input = z.infer<typeof input>;
  const tool = defineTool<Input>({
    name: EVENT_TOOL,
    description: "Create the event of an inbox proposal on the owner's primary calendar, with no attendees. The owner approves each call.",
    input,
    risk: 'write',
    // the owner decides every event, also one from a session that read no mail.
    needsApproval: true,
    source: 'google',
    serverId: 'google',
    accountOf: (each) => each.account,
    run: (each, toolCtx) => requestContext.run({ runId: toolCtx.runId, ...(toolCtx.toolCallId ? { toolCallId: toolCtx.toolCallId } : {}) }, () => createEvent(each)),
  });

  async function createEvent(call: Input): Promise<ToolOutput> {
    const row = proposalRow(ctx, call.proposalId);
    // the approval card showed these fields, so the call must name the row as it is. a refusal has no effect field,
    // because a second approval of the same call cannot help, so the proposal fails and leaves the approved state.
    if (!row) return { content: `${EVENT_TOOL} did not run: the proposal ${call.proposalId} does not exist.`, isError: true };
    if (
      row.account !== call.account ||
      row.kind !== call.kind ||
      row.title !== call.title ||
      row.startAt !== call.startAt ||
      row.endAt !== call.endAt ||
      row.allDay !== call.allDay ||
      row.description !== call.description
    ) {
      const content = `${EVENT_TOOL} did not run: the call does not match the proposal ${call.proposalId}.`;
      if (row.state !== 'created') ctx.db.prepare("UPDATE inbox_proposals SET state = 'failed', error = ?, resolvedAt = ? WHERE id = ?").run(content, ctx.clock().toISOString(), row.id);
      return { content, isError: true };
    }
    if (row.state === 'created') return { content: `the event ${row.eventId} of the proposal ${row.id} already exists in ${row.account}.` };
    const eventId = eventIdOf(eventSalt(ctx), row.account, row.dedupeKey);
    const done = (content: string): ToolOutput => {
      ctx.db.prepare("UPDATE inbox_proposals SET state = 'created', eventId = ?, error = NULL, resolvedAt = ? WHERE id = ?").run(eventId, ctx.clock().toISOString(), row.id);
      return { content };
    };
    // an all-day event has dates in the time zone of the app, and google ends it at the start of the next day.
    const day = localDay(new Date(row.startAt), ctx.timeZone);
    const when = row.allDay
      ? { start: { date: day }, end: { date: addDays(day, 1) } }
      : { start: { dateTime: row.startAt }, end: { dateTime: row.endAt ?? new Date(Date.parse(row.startAt) + DEFAULT_LENGTH_MS).toISOString() } };
    try {
      await ctx.google.accounts.run(row.account, (apis) =>
        apis.calendar.events.insert({
          calendarId: 'primary',
          // the event has no attendees, so google sends no invitation and no update to anyone.
          sendUpdates: 'none',
          requestBody: { id: eventId, summary: row.title, ...when, ...(row.description ? { description: row.description } : {}) },
        }),
      );
      return done(`created event ${eventId} in ${row.account}.`);
    } catch (err) {
      const error = toGoogleError(err);
      if (error.status === 409) return sameEvent(row, eventId, day);
      const output = failed(EVENT_TOOL, row.account, error, true);
      if (output.effect !== 'none') ctx.db.prepare("UPDATE inbox_proposals SET state = 'failed', error = ?, resolvedAt = ? WHERE id = ?").run(output.content, ctx.clock().toISOString(), row.id);
      return output;
    }

    // an event with the id exists. it counts as the event of this proposal only when it has the title and the start
    // of the proposal, so an old event of another deadline is never shown as made.
    async function sameEvent(proposal: ProposalRow, id: string, localStart: string): Promise<ToolOutput> {
      let event: { summary?: string | null; start?: { date?: string | null; dateTime?: string | null } | null };
      try {
        event = (await ctx.google.accounts.run(proposal.account, (apis) => apis.calendar.events.get({ calendarId: 'primary', eventId: id }))).data;
      } catch (err) {
        // the insert made nothing, so the approval can wait again.
        return { ...failed(EVENT_TOOL, proposal.account, toGoogleError(err), true), effect: 'none' };
      }
      const start = event.start ?? {};
      const sameStart = proposal.allDay ? start.date === localStart : Date.parse(start.dateTime ?? '') === Date.parse(proposal.startAt);
      if (event.summary === proposal.title && sameStart) return done(`the event ${id} already exists in ${proposal.account}, so this proposal made it before.`);
      const content = `${EVENT_TOOL} did not finish: the calendar has another event with the id ${id}, so no event was made.`;
      ctx.db.prepare("UPDATE inbox_proposals SET state = 'failed', error = ?, resolvedAt = ? WHERE id = ?").run(content, ctx.clock().toISOString(), proposal.id);
      return { content, isError: true };
    }
  }

  return [tool];
}
