import { createHash } from 'node:crypto';
import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import { z } from 'zod';
import type { Logger } from '../observability/logger.js';
import { cleanLine } from '../signals/store.js';
import { headOf } from '../text.js';
import { defineTool, type Tool, type ToolOutput } from '../tools/registry.js';
import type { GoogleAccounts, GoogleApis } from './accounts.js';
import type { GoogleConfig } from './config.js';
import { toGoogleError } from './errors.js';
import { badAddress, bodyText, header, rawMessage } from './mime.js';
import { failed, sendDraft } from './send.js';
import { requestContext } from './trace.js';
import { oneClick as realOneClick, planUnsubscribe, unsubscribeTargets, type OneClickResult } from './unsubscribe.js';

export const GOOGLE = 'google';
const name = (tool: string) => `${GOOGLE}__${tool}`;

export interface GoogleToolsDeps {
  accounts: GoogleAccounts;
  config: GoogleConfig;
  logger: Logger;
  // tests replace the https post of a one-click unsubscribe.
  oneClick?: (target: string) => Promise<OneClickResult>;
}

const MAX_RESULTS = 20;
// a thread can hold megabytes of quoted text. the caller turns a long result into a preview and a handle, but the
// text must first fit in memory and in a blob.
const THREAD_LIMIT = 200_000;

// every google tool names its account. the trace row keeps it, so the page counts the calls of each account. the
// requests of a call, a token refresh too, carry the run and the call, so the run timeline shows them.
function googleTool<I extends { account: string }>(tool: Omit<Tool<I>, 'source' | 'serverId' | 'accountOf'>): Tool {
  return defineTool<I>({
    ...tool,
    source: GOOGLE,
    serverId: GOOGLE,
    accountOf: (input) => input.account,
    run: (input, ctx) => requestContext.run({ runId: ctx.runId, ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}) }, () => tool.run(input, ctx)),
  });
}

// a header field with a line break could add a header that the owner did not approve.
const headerLine = (max: number) => z.string().max(max).regex(/^[^\r\n]*$/, 'a line break is not allowed');

export function createGoogleTools(deps: GoogleToolsDeps): Tool[] {
  const { accounts, config } = deps;
  const aliases = config.accounts.map((each) => each.alias) as [string, ...string[]];
  const account = z.enum(aliases).describe('the alias of the google account');
  const anyAccount = z.enum([...aliases, 'all']).describe('the alias of the google account, or all');
  const addresses = z.array(z.string()).max(50);
  const time = z.iso.datetime({ offset: true });
  const oneClick = deps.oneClick ?? realOneClick;

  // a read tool runs on each account that it names. one account that fails does not hide the others.
  const eachAccount = async (tool: string, which: string, source: 'gmail' | 'calendar', work: (apis: GoogleApis, alias: string) => Promise<string[]>): Promise<ToolOutput> => {
    const targets = which === 'all' ? aliases.filter((alias) => !accounts.unavailable(alias)) : [which];
    if (!targets.length) return { content: `${tool}: no google account is signed in.`, isError: true };
    const parts = await Promise.all(
      targets.map(async (alias) => {
        try {
          return { alias, lines: await accounts.run(alias, (apis) => work(apis, alias)) };
        } catch (err) {
          return { alias, error: failed(tool, alias, toGoogleError(err), false).content };
        }
      }),
    );
    const content = parts.map((part) => ('error' in part ? part.error! : part.lines!.length ? part.lines!.join('\n') : `[${part.alias}] nothing found`)).join('\n');
    return {
      content,
      ...(parts.every((part) => 'error' in part) ? { isError: true } : {}),
      // the source names each account, so the taint shows which mailbox the outside text came from.
      untrustedSource: targets.map((alias) => `${source}:${alias}`).join(', '),
    };
  };

  // work gives the output itself, so a check before the change can refuse the call.
  const write = async (tool: string, alias: string, work: (apis: GoogleApis) => Promise<ToolOutput>): Promise<ToolOutput> => {
    try {
      return await accounts.run(alias, work);
    } catch (err) {
      return failed(tool, alias, toGoogleError(err), true);
    }
  };

  // the owner approved a change of the event with this title. when the event has another title now, the call is not
  // the one that the owner approved. a refusal is not "no effect", because a second approval of it cannot help.
  const titleChanged = async (apis: GoogleApis, tool: string, eventId: string, currentTitle: string): Promise<ToolOutput | 'gone' | undefined> => {
    let event: calendar_v3.Schema$Event;
    try {
      event = (await apis.calendar.events.get({ calendarId: 'primary', eventId })).data;
    } catch (err) {
      const error = toGoogleError(err);
      if (error.kind === 'not_found' || error.kind === 'gone') return 'gone';
      throw err;
    }
    if (event.status === 'cancelled') return 'gone';
    const title = event.summary ?? '';
    if (title === currentTitle) return undefined;
    return { content: `${tool} did not run: the event ${eventId} is called ${JSON.stringify(title)}, not ${JSON.stringify(currentTitle)}.`, isError: true };
  };

  const messageIds = z.array(z.string().min(1).max(100)).min(1).max(100);

  const tools: Tool[] = [
    googleTool({
      name: name('gmail_search'),
      description: 'Search Gmail with Gmail search syntax (for example "from:school is:unread newer_than:7d"). Gives the id, thread, date, sender and subject of each message.',
      input: z.object({ account: anyAccount, query: z.string().max(500), max: z.number().int().min(1).max(MAX_RESULTS).default(10) }),
      risk: 'read',
      untrustedOutput: 'gmail',
      run: ({ account: which, query, max }) =>
        eachAccount(name('gmail_search'), which, 'gmail', async (apis, alias) => {
          const list = await apis.gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
          const messages = await Promise.all(
            (list.data.messages ?? []).map((each) =>
              apis.gmail.users.messages.get({ userId: 'me', id: each.id!, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date', 'List-Unsubscribe'] }),
            ),
          );
          return messages.map(({ data }) =>
            cleanLine(
              `[${alias}] id=${data.id} thread=${data.threadId} ${header(data, 'Date')} | ${header(data, 'From')} | ${header(data, 'Subject')} | ${data.snippet ?? ''}${header(data, 'List-Unsubscribe') ? ' | can unsubscribe' : ''}`,
              600,
            ),
          );
        }),
    }),
    googleTool({
      name: name('gmail_read_thread'),
      description: 'Read a Gmail thread: the headers and the text of each message, and the unsubscribe targets that the sender offers.',
      input: z.object({ account, threadId: z.string().min(1).max(100) }),
      risk: 'read',
      untrustedOutput: 'gmail',
      run: ({ account: alias, threadId }) =>
        eachAccount(name('gmail_read_thread'), alias, 'gmail', async (apis) => {
          const { data } = await apis.gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
          const text = (data.messages ?? [])
            .map((message: gmail_v1.Schema$Message) => {
              const targets = unsubscribeTargets(header(message, 'List-Unsubscribe'));
              const oneClickOk = /List-Unsubscribe=One-Click/i.test(header(message, 'List-Unsubscribe-Post'));
              return [
                `message ${message.id}`,
                ...['From', 'To', 'Cc', 'Date', 'Subject'].map((key) => `${key}: ${cleanLine(header(message, key), 500)}`),
                ...(targets.length ? [`unsubscribe targets: ${targets.map((target) => `${target}${target.startsWith('https:') && oneClickOk ? ' (one-click)' : ''}`).join(' ')}`] : []),
                '',
                bodyText(message.payload),
              ].join('\n');
            })
            .join('\n\n---\n\n');
          return [headOf(text, THREAD_LIMIT)];
        }),
    }),
    googleTool({
      name: name('gmail_list_labels'),
      description: 'List the Gmail labels of an account, with their ids.',
      input: z.object({ account: anyAccount }),
      risk: 'read',
      untrustedOutput: 'gmail',
      run: ({ account: which }) =>
        eachAccount(name('gmail_list_labels'), which, 'gmail', async (apis, alias) => {
          const { data } = await apis.gmail.users.labels.list({ userId: 'me' });
          return (data.labels ?? []).map((label) => cleanLine(`[${alias}] ${label.id}: ${label.name}`, 200));
        }),
    }),
    googleTool({
      name: name('gmail_draft'),
      description: 'Save a draft in Gmail. It does not send it.',
      input: z.object({ account, to: addresses.min(1), cc: addresses.optional(), subject: headerLine(500), body: z.string().max(100_000), threadId: z.string().max(100).optional() }),
      risk: 'write',
      async run(input) {
        const bad = badAddress([...input.to, ...(input.cc ?? [])]);
        if (bad !== undefined) return { content: `${JSON.stringify(bad)} is not a plain email address.`, isError: true, effect: 'none' };
        return write(name('gmail_draft'), input.account, async (apis) => {
          const { data } = await apis.gmail.users.drafts.create({
            userId: 'me',
            requestBody: { message: { raw: rawMessage(input), ...(input.threadId ? { threadId: input.threadId } : {}) } },
          });
          return { content: `saved draft ${data.id} in ${input.account}.` };
        });
      },
    }),
    ...(
      [
        ['gmail_archive', 'Archive Gmail messages (remove them from the inbox).', 'INBOX'],
        ['gmail_mark_read', 'Mark Gmail messages as read.', 'UNREAD'],
      ] as const
    ).map(([tool, description, label]) =>
      googleTool({
        name: name(tool),
        description,
        input: z.object({ account, messageIds }),
        risk: 'write',
        run: ({ account: alias, messageIds: ids }) =>
          write(name(tool), alias, async (apis) => {
            await apis.gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, removeLabelIds: [label] } });
            return { content: `${tool.replace('gmail_', '')}: ${ids.length} messages in ${alias}.` };
          }),
      }),
    ),
    googleTool({
      name: name('gmail_label'),
      description: 'Add or remove Gmail labels (by label id) on messages.',
      input: z.object({ account, messageIds, add: z.array(z.string().max(100)).default([]), remove: z.array(z.string().max(100)).default([]) }),
      risk: 'write',
      run: ({ account: alias, messageIds: ids, add, remove }) =>
        write(name('gmail_label'), alias, async (apis) => {
          await apis.gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, addLabelIds: add, removeLabelIds: remove } });
          return { content: `labels changed on ${ids.length} messages in ${alias}.` };
        }),
    }),
    googleTool({
      name: name('gmail_unsubscribe'),
      description:
        'Unsubscribe from a mailing list with the List-Unsubscribe header of a message. sender is the address in the From header. target must be one of the unsubscribe targets that gmail_read_thread shows for that message. The owner approves each call.',
      input: z.object({ account, messageId: z.string().min(1).max(100), sender: z.string().min(1).max(320), target: z.string().min(1).max(2000) }),
      risk: 'external',
      needsApproval: true,
      async run({ account: alias, messageId, sender, target }) {
        const tool = name('gmail_unsubscribe');
        let message: gmail_v1.Schema$Message;
        try {
          const metadataHeaders = ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Authentication-Results'];
          message = (await accounts.run(alias, (apis) => apis.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders }))).data;
        } catch (err) {
          return { ...failed(tool, alias, toGoogleError(err), true), effect: 'none' };
        }
        // the owner approved this sender and this target, so the message must still name both. a refusal has no
        // effect field: a second approval of the same call cannot help.
        const plan = planUnsubscribe(message, sender, target, config.send);
        if (plan.way === 'refused') return { content: `${tool} did not run: ${plan.text}.`, isError: true };
        if (plan.way === 'mailto') return sendDraft(accounts, tool, alias, { to: [plan.to], subject: plan.subject, body: plan.body });
        const result = await oneClick(target);
        if (result.ok) return { content: `unsubscribed: ${result.text}.` };
        return { content: `${tool} did not finish: ${result.text}.`, isError: true, ...(result.refused ? {} : { effect: result.sent ? 'unknown' : 'none' }) };
      },
    }),
    googleTool({
      name: name('calendar_list_events'),
      description: 'List calendar events between two times (ISO 8601 with an offset). account all merges every account.',
      input: z.object({ account: anyAccount, from: time, to: time }),
      risk: 'read',
      untrustedOutput: 'calendar',
      run: async ({ account: which, from, to }) => {
        const output = await eachAccount(name('calendar_list_events'), which, 'calendar', async (apis, alias) => {
          const { data } = await apis.calendar.events.list({ calendarId: 'primary', timeMin: from, timeMax: to, singleEvents: true, orderBy: 'startTime', maxResults: 100 });
          return (data.items ?? []).map((event) =>
            cleanLine(`${event.start?.dateTime ?? event.start?.date} [${alias}] id=${event.id} ${event.summary ?? '(no title)'}${event.organizer?.self ? '' : ` (from ${event.organizer?.email ?? 'someone'})`}`, 400),
          );
        });
        // the lines of all accounts sort by time, so a merged list reads as one day.
        return { ...output, content: output.content.split('\n').sort().join('\n') };
      },
    }),
    googleTool({
      name: name('calendar_freebusy'),
      description: 'Show the busy times between two times (ISO 8601 with an offset).',
      input: z.object({ account: anyAccount, from: time, to: time }),
      risk: 'read',
      untrustedOutput: 'calendar',
      run: ({ account: which, from, to }) =>
        eachAccount(name('calendar_freebusy'), which, 'calendar', async (apis, alias) => {
          const { data } = await apis.calendar.freebusy.query({ requestBody: { timeMin: from, timeMax: to, items: [{ id: 'primary' }] } });
          return (data.calendars?.primary?.busy ?? []).map((busy) => `[${alias}] busy ${busy.start} to ${busy.end}`);
        }),
    }),
    googleTool({
      name: name('calendar_create_event'),
      description:
        "Create an event on the owner's calendar. With attendees, google sends each of them an invitation, and the owner approves the call.",
      input: z.object({
        account,
        summary: z.string().min(1).max(500),
        start: time,
        end: time,
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
        attendees: addresses.optional(),
      }),
      risk: 'write',
      // an invitation goes to other people, so it is external. the caller then always asks the owner.
      riskFor: (input) => (input.attendees?.length ? 'external' : 'write'),
      async run({ attendees, ...input }, ctx) {
        const bad = attendees ? badAddress(attendees) : undefined;
        if (bad !== undefined) return { content: `${JSON.stringify(bad)} is not a plain email address.`, isError: true, effect: 'none' };
        // the id comes from the call, so a second run of the same approved call finds the first event instead of a
        // copy. hex digits are valid base32hex, which google needs for an event id.
        const id = `okc${createHash('sha256').update(`${ctx.runId}:${ctx.toolCallId ?? ''}`).digest('hex').slice(0, 32)}`;
        const tool = name('calendar_create_event');
        try {
          const { data } = await accounts.run(input.account, (apis) =>
            apis.calendar.events.insert({
              calendarId: 'primary',
              sendUpdates: attendees?.length ? 'all' : 'none',
              requestBody: {
                id,
                summary: input.summary,
                start: { dateTime: input.start },
                end: { dateTime: input.end },
                ...(input.description ? { description: input.description } : {}),
                ...(input.location ? { location: input.location } : {}),
                ...(attendees?.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
              },
            }),
          );
          return { content: `created event ${data.id} in ${input.account}${attendees?.length ? ` and invited ${attendees.join(', ')}` : ''}.` };
        } catch (err) {
          const error = toGoogleError(err);
          if (error.status === 409) return { content: `the event ${id} already exists in ${input.account}, so this call made it before.` };
          return failed(tool, input.account, error, true);
        }
      },
    }),
    googleTool({
      name: name('calendar_update_event'),
      description:
        'Change an event. currentTitle is the title that the event has now; the call does not run when it differs. attendees replaces the attendee list, and google sends each attendee an update. The owner approves each call.',
      input: z.object({
        account,
        eventId: z.string().min(1).max(1024),
        currentTitle: z.string().max(500),
        summary: z.string().max(500).optional(),
        start: time.optional(),
        end: time.optional(),
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
        attendees: addresses.optional(),
      }),
      risk: 'external',
      needsApproval: true,
      async run({ account: alias, eventId, currentTitle, attendees, start, end, ...fields }) {
        const tool = name('calendar_update_event');
        const bad = attendees ? badAddress(attendees) : undefined;
        if (bad !== undefined) return { content: `${JSON.stringify(bad)} is not a plain email address.`, isError: true, effect: 'none' };
        return write(tool, alias, async (apis) => {
          const changed = await titleChanged(apis, tool, eventId, currentTitle);
          if (changed === 'gone') return { content: `${tool} did not run: the event ${eventId} does not exist in ${alias}.`, isError: true };
          if (changed) return changed;
          await apis.calendar.events.patch({
            calendarId: 'primary',
            eventId,
            sendUpdates: 'all',
            requestBody: {
              ...fields,
              ...(start ? { start: { dateTime: start } } : {}),
              ...(end ? { end: { dateTime: end } } : {}),
              ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
            },
          });
          return { content: `updated event ${eventId} in ${alias}.` };
        });
      },
    }),
    googleTool({
      name: name('calendar_delete_event'),
      description: 'Delete an event. currentTitle is the title that the event has now; the call does not run when it differs. Google tells its attendees. The owner approves each call.',
      input: z.object({ account, eventId: z.string().min(1).max(1024), currentTitle: z.string().max(500) }),
      risk: 'external',
      needsApproval: true,
      run: ({ account: alias, eventId, currentTitle }) => {
        const tool = name('calendar_delete_event');
        // a delete that comes again after a lost answer finds the event gone. that is the result that the owner wanted.
        const done = { content: `the event ${eventId} is already deleted in ${alias}.` };
        return write(tool, alias, async (apis) => {
          const changed = await titleChanged(apis, tool, eventId, currentTitle);
          if (changed === 'gone') return done;
          if (changed) return changed;
          try {
            await apis.calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
          } catch (err) {
            const error = toGoogleError(err);
            if (error.kind === 'gone' || error.kind === 'not_found') return done;
            throw err;
          }
          return { content: `deleted event ${eventId} in ${alias}.` };
        });
      },
    }),
  ];

  if (config.send) {
    tools.push(
      googleTool({
        name: name('gmail_send'),
        description: 'Send an email. Recipients are plain addresses in lists. The owner approves each call.',
        input: z.object({
          account,
          to: addresses.min(1),
          cc: addresses.optional(),
          bcc: addresses.optional(),
          subject: headerLine(500),
          body: z.string().max(100_000),
          threadId: z.string().max(100).optional(),
          inReplyTo: headerLine(500).optional(),
        }),
        risk: 'external',
        needsApproval: true,
        run: ({ account: alias, ...draft }) => sendDraft(accounts, name('gmail_send'), alias, draft),
      }),
    );
  }
  return tools;
}

export function googleToolNames(config: Pick<GoogleConfig, 'send'>): string[] {
  return [
    'gmail_search',
    'gmail_read_thread',
    'gmail_list_labels',
    'gmail_draft',
    'gmail_archive',
    'gmail_mark_read',
    'gmail_label',
    'gmail_unsubscribe',
    ...(config.send ? ['gmail_send'] : []),
    'calendar_list_events',
    'calendar_freebusy',
    'calendar_create_event',
    'calendar_update_event',
    'calendar_delete_event',
  ].map(name);
}
