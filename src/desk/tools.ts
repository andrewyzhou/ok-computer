import { z } from 'zod';
import { defineTool, type Tool } from '../tools/registry.js';
import type { DeskContext } from './context.js';
import { LIMITS, LINK_KINDS, notBuilt } from './shared.js';

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

export function createDeskTools(_ctx: DeskContext): Tool[] {
  return [
    defineTool<z.infer<typeof createInput>>({
      name: 'delegation_create',
      description:
        'Put a job that the owner hands to you on the desk, so it is tracked until it is done. Use it when the owner asks you to handle, take care of, sort out or follow up on something that takes more than this reply. Returns the delegation number and its link.',
      input: createInput,
      risk: 'write',
      run: () => Promise.reject(notBuilt('delegation_create')),
    }),
    defineTool<z.infer<typeof updateInput>>({
      name: 'delegation_update',
      description: 'Change a delegation on the desk: its title, details, next step, due time, follow-up time, links, or status open or blocked. Add a note for the history.',
      input: updateInput,
      risk: 'write',
      run: () => Promise.reject(notBuilt('delegation_update')),
    }),
    defineTool<z.infer<typeof waitOnInput>>({
      name: 'delegation_wait_on',
      description:
        'Mark a delegation as waiting on a person, with a follow-up time. At that time the app checks the mail thread for a reply, and saves a nudge as a Gmail draft when none came. Drafts are never sent.',
      input: waitOnInput,
      risk: 'write',
      run: () => Promise.reject(notBuilt('delegation_wait_on')),
    }),
    defineTool<z.infer<typeof doneInput>>({
      name: 'delegation_done',
      description: 'Close a delegation as done, or as dropped when the owner no longer wants it. Say what came of it in the note.',
      input: doneInput,
      risk: 'write',
      run: () => Promise.reject(notBuilt('delegation_done')),
    }),
    defineTool<z.infer<typeof listInput>>({
      name: 'delegation_list',
      description: 'List the delegations on the desk. The default is the active ones (open, waiting and blocked), the ones due first.',
      input: listInput,
      risk: 'read',
      run: () => Promise.reject(notBuilt('delegation_list')),
    }),
  ];
}
