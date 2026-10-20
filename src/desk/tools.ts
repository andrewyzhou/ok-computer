import { z } from 'zod';
import type { Delegation, DelegationLinkInput, DelegationStatus, WaitingOn } from '../dashboard/desk-types.js';
import { sessionTaint } from '../policy/store.js';
import { addDays, formatLocal, localDay, zonedToUtc } from '../time.js';
import { defineTool, type Tool, type ToolContext, type ToolOutput } from '../tools/registry.js';
import type { DeskContext } from './context.js';
import { ACTIVE_STATUSES, isClosed, LIMITS, LINK_KINDS, parseWhen, personKey, validEmail } from './shared.js';
import { createDelegation, getDelegation, listDelegations, updateDelegation, type ChangeBy, type StoreResult } from './store.js';

// the agent tools of the desk: delegation_create, delegation_update, delegation_wait_on, delegation_done and
// delegation_list. the main session lists all five (DESK_MAIN_TOOLS in names.ts), and an isolated automation lists
// only delegation_list (DESK_AUTO_TOOLS). the input schemas below are the contract that docs/API.md (T3) describes.
// the work package "agent tools" fills each run: it parses the times with parseWhen, writes through store.ts with
// { actor: 'agent', runId, toolCallId } from the tool context, and answers with a short text that names the
// delegation as #<id> "<title>" with its desk link.

const when = z.string().min(1).max(40);
const person = z
  .object({ name: z.string().min(1).max(LIMITS.name).optional(), email: z.string().min(3).max(LIMITS.email).optional() })
  .strict()
  .describe('Who it waits on: a name, an email, or both. Give the email when you know it, so the follow-up can find the reply.');
const link = z
  .object({
    kind: z.enum(LINK_KINDS as [string, ...string[]]),
    ref: z.string().min(1).max(LIMITS.ref).describe('The run id, doc id, Gmail thread id or calendar event id.'),
    account: z.string().min(1).max(100).optional().describe('The Google account alias of a thread or an event.'),
    label: z.string().min(1).max(LIMITS.label).optional(),
  })
  .strict();
const id = z.number().int().positive().describe('The delegation number, as in #12.');

export const createInput = z
  .object({
    title: z.string().min(1).max(LIMITS.title).describe('A short name of the job, for example "Book the Denver flights".'),
    details: z.string().min(1).max(LIMITS.details).optional(),
    nextStep: z.string().min(1).max(LIMITS.nextStep).optional().describe('The next step in words for the owner.'),
    waitingOn: person.optional(),
    dueAt: when.optional().describe('When the owner needs it: yyyy-mm-dd, "yyyy-mm-dd HH:MM" in the owner\'s time zone, or an iso time.'),
    followUpAt: when.optional().describe('When to check on it next, in the same forms as dueAt.'),
    links: z.array(link).max(LIMITS.links).optional(),
  })
  .strict();

export const updateInput = z
  .object({
    id,
    title: z.string().min(1).max(LIMITS.title).optional(),
    details: z.string().max(LIMITS.details).nullable().optional(),
    nextStep: z.string().max(LIMITS.nextStep).nullable().optional(),
    status: z.enum(['open', 'blocked']).optional().describe('Use delegation_wait_on to wait on someone, and delegation_done to close it.'),
    dueAt: when.nullable().optional(),
    followUpAt: when.nullable().optional(),
    addLinks: z.array(link).max(LIMITS.links).optional(),
    removeLinks: z.array(link.pick({ kind: true, ref: true, account: true })).max(LIMITS.links).optional(),
    note: z.string().min(1).max(LIMITS.note).optional().describe('A line for the history, for example what you did.'),
  })
  .strict();

export const waitOnInput = z
  .object({
    id,
    waitingOn: person,
    followUpAt: when.optional().describe('When to check for a reply. The default is two days from now at 09:00.'),
    thread: z
      .object({ account: z.string().min(1).max(100), threadId: z.string().min(1).max(LIMITS.ref) })
      .strict()
      .optional()
      .describe('The Gmail thread where the reply will come, so the follow-up can check it.'),
    note: z.string().min(1).max(LIMITS.note).optional(),
  })
  .strict();

export const doneInput = z
  .object({
    id,
    outcome: z.enum(['done', 'dropped']).default('done'),
    note: z.string().min(1).max(LIMITS.note).optional().describe('What came of it, in one line.'),
  })
  .strict();

export const listInput = z
  .object({
    status: z.enum(['active', 'open', 'waiting', 'blocked', 'done', 'dropped', 'all']).default('active'),
    person: z.string().min(1).max(LIMITS.email).optional().describe('A name or an email of the person it waits on.'),
    q: z.string().min(1).max(LIMITS.q).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

type Person = { name?: string | undefined; email?: string | undefined };
type LinkIn = { kind: string; ref: string; account?: string | undefined; label?: string | undefined };
type Time = { ok: true; iso: string } | { ok: false; error: string };

const failed = (content: string): ToolOutput => ({ content, isError: true });
const named = (delegation: Pick<Delegation, 'id' | 'title'>) => `#${delegation.id} "${delegation.title}"`;
const at = (iso: string, timeZone: string) => formatLocal(new Date(iso), timeZone);
const personText = (waitingOn: WaitingOn) =>
  waitingOn.name && waitingOn.email ? `${waitingOn.name} <${waitingOn.email}>` : (waitingOn.name ?? waitingOn.email ?? '');
const linkKey = (link: { kind: string; ref: string; account?: string | null }) => `${link.kind}|${link.account ?? ''}|${link.ref}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// every write of a tool names the run and the tool call, so the history row leads back to the trace.
const changeBy = (toolCtx: ToolContext): ChangeBy => ({ actor: 'agent', runId: toolCtx.runId, toolCallId: toolCtx.toolCallId ?? null });

// a due time can be in the past, because the owner may record a date that has gone by. a follow-up time in the past
// would fire at once, so it is an error.
function timeOf(value: string, toolCtx: ToolContext, kind: 'due' | 'followUp'): Time {
  const parsed = parseWhen(value, toolCtx.timeZone, kind);
  if (!parsed.ok) return parsed;
  if (kind === 'followUp' && Date.parse(parsed.iso) <= toolCtx.clock().getTime()) {
    return { ok: false, error: `the follow-up time ${at(parsed.iso, toolCtx.timeZone)} is not in the future. Pick a later time.` };
  }
  return parsed;
}

function personError(person: Person): string | undefined {
  if (!person.name?.trim() && !person.email?.trim()) return 'waitingOn needs a name or an email';
  if (person.email !== undefined && !validEmail(person.email)) return `"${person.email}" is not one plain email address`;
  return undefined;
}

// a thread or an event lives in one google account, so its link needs the alias. with a google config the alias must
// be one of its accounts, so the follow-up job can read the thread.
function linkError(ctx: DeskContext, link: LinkIn): string | undefined {
  if (link.kind !== 'thread' && link.kind !== 'event') return undefined;
  const account = link.account?.trim();
  if (!account) return `a ${link.kind} link needs the account, the alias of its Google account`;
  const aliases = ctx.googleConfig?.accounts.map((each) => each.alias);
  if (aliases && !aliases.includes(account)) return `"${account}" is not a Google account of the app. Use one of: ${aliases.join(', ')}`;
  return undefined;
}

function linksError(ctx: DeskContext, links: readonly LinkIn[] | undefined): string | undefined {
  for (const link of links ?? []) {
    const error = linkError(ctx, link);
    if (error) return error;
  }
  return undefined;
}

const asLinks = (links: readonly LinkIn[] | undefined) => (links ?? []) as DelegationLinkInput[];

// the lines under a created delegation: its due time, its person and its follow-up time, when they are set.
function factLines(delegation: Delegation, timeZone: string): string[] {
  const lines: string[] = [];
  if (delegation.dueAt) lines.push(`Due: ${at(delegation.dueAt, timeZone)}`);
  if (delegation.waitingOn) lines.push(`Waiting on: ${personText(delegation.waitingOn)}`);
  if (delegation.nextFollowUpAt) lines.push(`Follow-up: ${at(delegation.nextFollowUpAt, timeZone)}`);
  return lines;
}

function listLine(delegation: Delegation, timeZone: string): string {
  const parts = [`#${delegation.id} ${delegation.status} "${delegation.title}"`];
  if (delegation.waitingOn) {
    const since = delegation.waitingSince ? ` since ${at(delegation.waitingSince, timeZone)}` : '';
    parts.push(`waiting on ${delegation.waitingOn.name ?? delegation.waitingOn.email}${since}`);
  }
  if (delegation.dueAt) parts.push(`due ${at(delegation.dueAt, timeZone)}`);
  if (delegation.nextFollowUpAt) parts.push(`follow-up ${at(delegation.nextFollowUpAt, timeZone)}`);
  if (delegation.nextStep) parts.push(`next: ${delegation.nextStep}`);
  return parts.join(' · ');
}

const historyCount = (ctx: DeskContext, id: number) =>
  Number(ctx.db.prepare('SELECT count(*) AS n FROM delegation_events WHERE delegationId = ?').get(id)!.n);

// the words of an update: what differs between the row before and the row after.
function changesOf(before: Delegation, after: Delegation, timeZone: string, noted: boolean): string[] {
  const changes: string[] = [];
  if (after.title !== before.title) changes.push(`title "${after.title}"`);
  if (after.details !== before.details) changes.push(after.details ? 'details' : 'details cleared');
  if (after.nextStep !== before.nextStep) changes.push(after.nextStep ? `next step "${after.nextStep}"` : 'next step cleared');
  if (after.status !== before.status) changes.push(`status ${after.status}`);
  if (after.dueAt !== before.dueAt) changes.push(after.dueAt ? `due ${at(after.dueAt, timeZone)}` : 'due time cleared');
  if (after.nextFollowUpAt !== before.nextFollowUpAt) {
    changes.push(after.nextFollowUpAt ? `follow-up ${at(after.nextFollowUpAt, timeZone)}` : 'follow-up cleared');
  }
  const had = new Set(before.links.map(linkKey));
  const has = new Set(after.links.map(linkKey));
  const added = after.links.filter((link) => !had.has(linkKey(link))).length;
  const removed = before.links.filter((link) => !has.has(linkKey(link))).length;
  if (added) changes.push(`${plural(added, 'link')} added`);
  if (removed) changes.push(`${plural(removed, 'link')} removed`);
  if (noted) changes.push('a note in the history');
  return changes;
}

// titles and next steps can come from mail that a tainted session read, or from the follow-up job, which reads
// threads. a list with such a row is outside text, so the caller wraps it as untrusted.
function fromOutside(ctx: DeskContext, delegations: readonly Delegation[]): boolean {
  const keys = new Set(delegations.map((each) => each.sessionKey).filter((key): key is string => Boolean(key)));
  for (const key of keys) if (sessionTaint(ctx.db, key).length) return true;
  if (!delegations.length) return false;
  const ids = delegations.map((each) => each.id);
  const row = ctx.db
    .prepare(`SELECT 1 AS found FROM delegation_events WHERE actor = 'system' AND delegationId IN (${ids.map(() => '?').join(', ')}) LIMIT 1`)
    .get(...ids);
  return Boolean(row);
}

// the status filter of the list. active means every status that is still in flight, and all means no filter.
function statusesOf(status: z.infer<typeof listInput>['status']): readonly DelegationStatus[] | undefined {
  if (status === 'active') return ACTIVE_STATUSES;
  if (status === 'all') return undefined;
  return [status];
}

export function createDeskTools(ctx: DeskContext): Tool[] {
  // a tool never throws. an unexpected error goes to the log with its stack, and the model gets a short error.
  const guard = async (name: string, work: () => ToolOutput): Promise<ToolOutput> => {
    try {
      return work();
    } catch (err) {
      ctx.logger.error('a desk tool failed', { tool: name, err });
      return failed(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const answerOf = <T>(result: StoreResult<T>, ok: (value: T) => ToolOutput): ToolOutput => (result.ok ? ok(result.value) : failed(result.error));

  return [
    defineTool<z.infer<typeof createInput>>({
      name: 'delegation_create',
      description:
        'Put a job that the owner hands to you on the desk, so it is tracked until it is done. Use it when the owner asks you to handle, take care of, sort out or follow up on something that takes more than this reply. Returns the delegation number and its link.',
      input: createInput,
      risk: 'write',
      run: (input, toolCtx) =>
        guard('delegation_create', () => {
          const title = input.title.trim();
          if (!title) return failed('the title is empty');
          const dueAt = input.dueAt === undefined ? undefined : timeOf(input.dueAt, toolCtx, 'due');
          if (dueAt && !dueAt.ok) return failed(dueAt.error);
          const followUp = input.followUpAt === undefined ? undefined : timeOf(input.followUpAt, toolCtx, 'followUp');
          if (followUp && !followUp.ok) return failed(followUp.error);
          const personProblem = input.waitingOn ? personError(input.waitingOn) : undefined;
          if (personProblem) return failed(personProblem);
          const linkProblem = linksError(ctx, input.links);
          if (linkProblem) return failed(linkProblem);

          // a model that retries a call must not put the same job on the desk two times.
          const same = listDelegations(ctx.db, { statuses: ACTIVE_STATUSES }).find((each) => each.title.trim().toLowerCase() === title.toLowerCase());
          if (same) return { content: `Already on the desk as ${named(same)} (${same.status}). ${ctx.deskLink(same.id)}` };

          const result = createDelegation(
            ctx.db,
            {
              title,
              details: input.details ?? null,
              nextStep: input.nextStep ?? null,
              waitingOn: input.waitingOn ?? null,
              dueAt: dueAt?.ok ? dueAt.iso : null,
              nextFollowUpAt: followUp?.ok ? followUp.iso : null,
              links: [{ kind: 'run', ref: toolCtx.runId, label: 'The run that created it' }, ...asLinks(input.links)],
              createdBy: 'agent',
              sessionKey: toolCtx.sessionKey,
              runId: toolCtx.runId,
            },
            changeBy(toolCtx),
            toolCtx.clock(),
          );
          return answerOf(result, (delegation) => ({
            content: [`Added to the desk as ${named(delegation)} (${delegation.status}). ${ctx.deskLink(delegation.id)}`, ...factLines(delegation, toolCtx.timeZone)].join('\n'),
          }));
        }),
    }),
    defineTool<z.infer<typeof updateInput>>({
      name: 'delegation_update',
      description:
        'Change a delegation on the desk: its title, details, next step, due time, follow-up time, links, or status open or blocked. null clears a field. Add a note for the history.',
      input: updateInput,
      risk: 'write',
      run: (input, toolCtx) =>
        guard('delegation_update', () => {
          const title = input.title?.trim();
          if (input.title !== undefined && !title) return failed('the title is empty');
          const dueAt = input.dueAt ? timeOf(input.dueAt, toolCtx, 'due') : undefined;
          if (dueAt && !dueAt.ok) return failed(dueAt.error);
          const followUp = input.followUpAt ? timeOf(input.followUpAt, toolCtx, 'followUp') : undefined;
          if (followUp && !followUp.ok) return failed(followUp.error);
          const linkProblem = linksError(ctx, input.addLinks);
          if (linkProblem) return failed(linkProblem);

          const before = getDelegation(ctx.db, input.id);
          const historyBefore = before ? historyCount(ctx, input.id) : 0;
          const result = updateDelegation(
            ctx.db,
            input.id,
            {
              ...(title !== undefined ? { title } : {}),
              ...(input.details !== undefined ? { details: input.details } : {}),
              ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}),
              ...(input.status ? { status: input.status } : {}),
              ...(input.dueAt !== undefined ? { dueAt: dueAt?.ok ? dueAt.iso : null } : {}),
              ...(input.followUpAt !== undefined ? { nextFollowUpAt: followUp?.ok ? followUp.iso : null } : {}),
              ...(input.addLinks ? { addLinks: asLinks(input.addLinks) } : {}),
              ...(input.removeLinks ? { removeLinks: asLinks(input.removeLinks) } : {}),
              ...(input.note ? { note: input.note } : {}),
            },
            changeBy(toolCtx),
            toolCtx.clock(),
          );
          return answerOf(result, (after) => {
            if (!before || historyCount(ctx, input.id) === historyBefore) return { content: `Nothing changed on #${after.id}.` };
            const changes = changesOf(before, after, toolCtx.timeZone, Boolean(input.note?.trim()));
            return { content: `Updated ${named(after)}: ${changes.join(', ') || 'the history'}. ${ctx.deskLink(after.id)}` };
          });
        }),
    }),
    defineTool<z.infer<typeof waitOnInput>>({
      name: 'delegation_wait_on',
      description:
        'Mark a delegation as waiting on a person, with a follow-up time. Give the Gmail thread where the reply will come. At the follow-up time the app checks that thread for a reply, and saves a nudge as a Gmail draft when none came. Drafts are never sent.',
      input: waitOnInput,
      risk: 'write',
      run: (input, toolCtx) =>
        guard('delegation_wait_on', () => {
          const before = getDelegation(ctx.db, input.id);
          if (!before) return failed(`delegation #${input.id} not found`);
          if (isClosed(before.status)) return failed(`${named(before)} is ${before.status}, so it cannot wait on anyone. Nothing changed.`);
          const personProblem = personError(input.waitingOn);
          if (personProblem) return failed(personProblem);
          const thread = input.thread ? { kind: 'thread', ref: input.thread.threadId, account: input.thread.account, label: 'The thread of the reply' } : undefined;
          const linkProblem = thread ? linkError(ctx, thread) : undefined;
          if (linkProblem) return failed(linkProblem);
          const now = toolCtx.clock();
          let followUpAt: string;
          if (input.followUpAt !== undefined) {
            const parsed = timeOf(input.followUpAt, toolCtx, 'followUp');
            if (!parsed.ok) return failed(parsed.error);
            followUpAt = parsed.iso;
          } else {
            followUpAt = zonedToUtc(addDays(localDay(now, toolCtx.timeZone), 2), '09:00', toolCtx.timeZone).toISOString();
          }

          const result = updateDelegation(
            ctx.db,
            input.id,
            {
              status: 'waiting',
              waitingOn: input.waitingOn,
              nextFollowUpAt: followUpAt,
              ...(thread ? { addLinks: asLinks([thread]) } : {}),
              ...(input.note ? { note: input.note } : {}),
            },
            changeBy(toolCtx),
            now,
          );
          return answerOf(result, (after) => {
            const check = after.links.some((link) => link.kind === 'thread')
              ? 'it checks the mail thread for a reply, and when none came it saves a nudge as a Gmail draft'
              : 'there is no mail thread to check, so the owner is told that it is due';
            const person = after.waitingOn ? personText(after.waitingOn) : 'them';
            const when = after.nextFollowUpAt ? at(after.nextFollowUpAt, toolCtx.timeZone) : 'not set';
            return {
              content: `${named(after)} now waits on ${person}. The follow-up is ${when}: ${check}. A nudge is only ever saved as a Gmail draft, and it is never sent. ${ctx.deskLink(after.id)}`,
            };
          });
        }),
    }),
    defineTool<z.infer<typeof doneInput>>({
      name: 'delegation_done',
      description: 'Close a delegation as done, or as dropped when the owner no longer wants it. Say what came of it in the note.',
      input: doneInput,
      risk: 'write',
      run: (input, toolCtx) =>
        guard('delegation_done', () => {
          const before = getDelegation(ctx.db, input.id);
          if (!before) return failed(`delegation #${input.id} not found`);
          if (isClosed(before.status)) return failed(`${named(before)} is already ${before.status}. Nothing changed.`);
          const result = updateDelegation(ctx.db, input.id, { status: input.outcome, ...(input.note ? { note: input.note } : {}) }, changeBy(toolCtx), toolCtx.clock());
          return answerOf(result, (after) => ({ content: `Closed ${named(after)} as ${input.outcome}.` }));
        }),
    }),
    defineTool<z.infer<typeof listInput>>({
      name: 'delegation_list',
      description:
        'List the delegations on the desk. The default is the active ones (open, waiting and blocked), the ones due first. Filter by the person it waits on, with a name or an email, or by words in the title, details or next step.',
      input: listInput,
      risk: 'read',
      run: (input, toolCtx) =>
        guard('delegation_list', () => {
          const statuses = statusesOf(input.status);
          const filter = { ...(statuses ? { statuses } : {}), ...(input.q ? { q: input.q } : {}) };
          let rows: Delegation[];
          const text = input.person?.trim();
          if (text) {
            const key = personKey(text.includes('@') ? { email: text } : { name: text });
            rows = key ? listDelegations(ctx.db, { ...filter, person: key, limit: input.limit }) : [];
            // the key of a row with an email is the email, so a bare name finds it only through this match.
            if (!rows.length) {
              const needle = text.toLowerCase();
              rows = listDelegations(ctx.db, { ...filter, statuses: statuses ?? ACTIVE_STATUSES })
                .filter((each) => [each.waitingOn?.name, each.waitingOn?.email].some((value) => value?.toLowerCase().includes(needle)))
                .slice(0, input.limit);
            }
          } else {
            rows = listDelegations(ctx.db, { ...filter, limit: input.limit });
          }
          if (!rows.length) {
            const which = input.status === 'all' ? '' : `${input.status} `;
            return { content: `The desk has no ${which}delegations${text ? ` for ${text}` : ''}.` };
          }
          const content = rows.map((each) => listLine(each, toolCtx.timeZone)).join('\n');
          return fromOutside(ctx, rows) ? { content, untrustedSource: 'desk' } : { content };
        }),
    }),
  ];
}

