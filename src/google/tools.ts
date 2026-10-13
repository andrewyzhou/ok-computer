import { createHash } from 'node:crypto';
import type { gmail_v1 } from '@googleapis/gmail';
import { z } from 'zod';
import type { Logger } from '../observability/logger.js';
import { headOf } from '../text.js';
import { defineTool, type Tool, type ToolOutput } from '../tools/registry.js';
import type { GoogleAccounts, GoogleApis } from './accounts.js';
import type { GoogleConfig } from './config.js';
import { GoogleError, toGoogleError } from './errors.js';
import { badAddress, rawMessage, type Draft } from './mime.js';
import { cleanLine } from './signals.js';
import { oneClick as realOneClick, unsubscribeTargets, type OneClickResult } from './unsubscribe.js';

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

// a failed write says whether google can have acted. no answer after the request left means that the effect is
// unknown. a refused connection, or a 4xx answer, means that google did not act, so a retry is safe.
function failed(tool: string, alias: string, error: GoogleError, write: boolean): ToolOutput {
  const hint =
    error.kind === 'scope'
      ? ' The sign-in lacks a permission; the owner connects the account again and ticks every box.'
      : error.kind === 'rate'
        ? ' Google limits the rate; try again in a few minutes.'
        : '';
  const answered = error.status !== undefined && error.status < 500;
  const effect = !write || !error.reached || answered ? ('none' as const) : ('unknown' as const);
  const unknown = effect === 'unknown' ? ' The request left, but no answer came, so it is unknown whether it worked. Check before you try again.' : '';
  return { content: `${tool} failed for ${alias}: ${error.message}.${hint}${unknown}`, isError: true, ...(write ? { effect } : {}) };
}

export function createGoogleTools(deps: GoogleToolsDeps): Tool[] {
  const { accounts, config } = deps;
  const aliases = config.accounts.map((each) => each.alias) as [string, ...string[]];
  const account = z.enum(aliases).describe('the alias of the google account');
  const anyAccount = z.enum([...aliases, 'all']).describe('the alias of the google account, or all');
  const addresses = z.array(z.string()).max(50);
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

  const write = async (tool: string, alias: string, work: (apis: GoogleApis) => Promise<string>): Promise<ToolOutput> => {
    try {
      return { content: await accounts.run(alias, work) };
    } catch (err) {
      return failed(tool, alias, toGoogleError(err), true);
    }
  };

  const header = (message: gmail_v1.Schema$Message, key: string) =>
    message.payload?.headers?.find((each) => each.name?.toLowerCase() === key.toLowerCase())?.value ?? '';

  const sendDraft = async (tool: string, alias: string, draft: Draft & { threadId?: string }): Promise<ToolOutput> => {
    const bad = badAddress([...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])]);
    if (bad !== undefined) return { content: `${tool} did not run: ${JSON.stringify(bad)} is not a plain email address.`, isError: true, effect: 'none' };
    let draftId: string;
    try {
      const created = await accounts.run(alias, (apis) =>
        apis.gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: rawMessage(draft), ...(draft.threadId ? { threadId: draft.threadId } : {}) } } }),
      );
      draftId = created.data.id!;
    } catch (err) {
      // no mail left in this step. at worst a draft stays.
      return { ...failed(tool, alias, toGoogleError(err), true), effect: 'none' };
    }
    // the send goes through a draft, because gmail has no idempotency key. when the answer is lost, the draft tells
    // what happened: google deletes a draft when it sends it.
    try {
      const sent = await accounts.run(alias, (apis) => apis.gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } }));
      return { content: `sent from ${alias} to ${draft.to.join(', ')} as message ${sent.data.id}.` };
    } catch (err) {
      const error = toGoogleError(err);
      if (!error.reached || (error.status !== undefined && error.status < 500)) {
        return { content: `${tool} did not send from ${alias}: ${error.message}. The draft ${draftId} stays in Drafts.`, isError: true, effect: 'none' };
      }
      try {
        await accounts.run(alias, (apis) => apis.gmail.users.drafts.get({ userId: 'me', id: draftId }));
        return { content: `${tool} did not send from ${alias} (${error.message}). Google still has the draft ${draftId}, so the message did not go out.`, isError: true, effect: 'none' };
      } catch (check) {
        if (toGoogleError(check).kind === 'not_found') return { content: `sent from ${alias} to ${draft.to.join(', ')}. The answer was lost (${error.message}), but google no longer has the draft, so it went out.` };
        return failed(tool, alias, error, true);
      }
    }
  };

  const tools: Tool[] = [
    defineTool({
      name: name('gmail_search'),
      description: 'Search Gmail with Gmail search syntax (for example "from:school is:unread newer_than:7d"). Gives the id, thread, date, sender and subject of each message.',
      input: z.object({ account: anyAccount, query: z.string().max(500), max: z.number().int().min(1).max(MAX_RESULTS).default(10) }),
      risk: 'read',
      untrustedOutput: 'gmail',
      source: GOOGLE,
      serverId: GOOGLE,
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
    defineTool({
      name: name('gmail_read_thread'),
      description: 'Read a Gmail thread: the headers and the text of each message, and the unsubscribe targets that the sender offers.',
      input: z.object({ account, threadId: z.string().min(1).max(100) }),
      risk: 'read',
      untrustedOutput: 'gmail',
      source: GOOGLE,
      serverId: GOOGLE,
      run: ({ account: alias, threadId }) =>
        eachAccount(name('gmail_read_thread'), alias, 'gmail', async (apis) => {
          const { data } = await apis.gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
          const text = (data.messages ?? [])
            .map((message) => {
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
    defineTool({
      name: name('gmail_list_labels'),
      description: 'List the Gmail labels of an account, with their ids.',
      input: z.object({ account: anyAccount }),
      risk: 'read',
      untrustedOutput: 'gmail',
      source: GOOGLE,
      serverId: GOOGLE,
      run: ({ account: which }) =>
        eachAccount(name('gmail_list_labels'), which, 'gmail', async (apis, alias) => {
          const { data } = await apis.gmail.users.labels.list({ userId: 'me' });
          return (data.labels ?? []).map((label) => cleanLine(`[${alias}] ${label.id}: ${label.name}`, 200));
        }),
    }),
    defineTool({
      name: name('gmail_draft'),
      description: 'Save a draft in Gmail. It does not send it.',
      input: z.object({ account, to: addresses.min(1), cc: addresses.optional(), subject: z.string().max(500), body: z.string().max(100_000), threadId: z.string().max(100).optional() }),
      risk: 'write',
      source: GOOGLE,
      serverId: GOOGLE,
      async run(input) {
        const bad = badAddress([...input.to, ...(input.cc ?? [])]);
        if (bad !== undefined) return { content: `${JSON.stringify(bad)} is not a plain email address.`, isError: true, effect: 'none' };
        return write(name('gmail_draft'), input.account, async (apis) => {
          const { data } = await apis.gmail.users.drafts.create({
            userId: 'me',
            requestBody: { message: { raw: rawMessage(input), ...(input.threadId ? { threadId: input.threadId } : {}) } },
          });
          return `saved draft ${data.id} in ${input.account}.`;
        });
      },
    }),
    ...(
      [
        ['gmail_archive', 'Archive Gmail messages (remove them from the inbox).', { removeLabelIds: ['INBOX'] }],
        ['gmail_mark_read', 'Mark Gmail messages as read.', { removeLabelIds: ['UNREAD'] }],
      ] as const
    ).map(([tool, description, change]) =>
      defineTool({
        name: name(tool),
        description,
        input: z.object({ account, messageIds: z.array(z.string().min(1).max(100)).min(1).max(100) }),
        risk: 'write',
        source: GOOGLE,
        serverId: GOOGLE,
        run: ({ account: alias, messageIds }) =>
          write(name(tool), alias, async (apis) => {
            await apis.gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: messageIds, removeLabelIds: [...change.removeLabelIds] } });
            return `${tool.replace('gmail_', '')}: ${messageIds.length} messages in ${alias}.`;
          }),
      }),
    ),
    defineTool({
      name: name('gmail_label'),
      description: 'Add or remove Gmail labels (by label id) on messages.',
      input: z.object({
        account,
        messageIds: z.array(z.string().min(1).max(100)).min(1).max(100),
        add: z.array(z.string().max(100)).default([]),
        remove: z.array(z.string().max(100)).default([]),
      }),
      risk: 'write',
      source: GOOGLE,
      serverId: GOOGLE,
      run: ({ account: alias, messageIds, add, remove }) =>
        write(name('gmail_label'), alias, async (apis) => {
          await apis.gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: messageIds, addLabelIds: add, removeLabelIds: remove } });
          return `labels changed on ${messageIds.length} messages in ${alias}.`;
        }),
    }),
    defineTool({
      name: name('gmail_unsubscribe'),
      description:
        'Unsubscribe from a mailing list with the List-Unsubscribe header of a message. target must be one of the unsubscribe targets that gmail_read_thread shows for that message. The owner approves each call.',
      input: z.object({ account, messageId: z.string().min(1).max(100), target: z.string().min(1).max(2000) }),
      risk: 'external',
      needsApproval: true,
      source: GOOGLE,
      serverId: GOOGLE,
      async run({ account: alias, messageId, target }) {
        const tool = name('gmail_unsubscribe');
        let message: gmail_v1.Schema$Message;
        try {
          message = (await accounts.run(alias, (apis) => apis.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post', 'Authentication-Results'] }))).data;
        } catch (err) {
          return { ...failed(tool, alias, toGoogleError(err), true), effect: 'none' };
        }
        // the target comes from the header at run time, never from the model alone. the owner approved this exact
        // target, and the header must still offer it.
        const targets = unsubscribeTargets(header(message, 'List-Unsubscribe'));
        if (!targets.includes(target)) {
          return { content: `${tool} did not run: the message does not offer ${JSON.stringify(target)}. It offers: ${targets.join(' ') || 'nothing'}.`, isError: true, effect: 'none' };
        }
        if (target.toLowerCase().startsWith('mailto:')) {
          if (!config.send) return { content: `${tool} did not run: this sender unsubscribes by mail, and sending is off for the google integration.`, isError: true, effect: 'none' };
          const mailto = new URL(target);
          return sendDraft(tool, alias, { to: [decodeURIComponent(mailto.pathname)], subject: mailto.searchParams.get('subject') ?? 'unsubscribe', body: mailto.searchParams.get('body') ?? 'unsubscribe' });
        }
        // rfc 8058 needs the post header, and a dkim signature that covers both headers. without a passed dkim check
        // the header can be forged, and the post would go to a server of the forger.
        if (!/List-Unsubscribe=One-Click/i.test(header(message, 'List-Unsubscribe-Post'))) {
          return { content: `${tool} did not run: the sender offers no one-click unsubscribe. The owner can open the link in a browser.`, isError: true, effect: 'none' };
        }
        const results = (message.payload?.headers ?? []).filter((each) => each.name?.toLowerCase() === 'authentication-results').map((each) => each.value ?? '');
        if (!results.some((value) => /\bdkim=pass\b/i.test(value))) {
          return { content: `${tool} did not run: gmail did not see a passing dkim signature on this message, so its unsubscribe header can be forged.`, isError: true, effect: 'none' };
        }
        const result = await oneClick(target);
        if (result.ok) return { content: `unsubscribed: ${result.text}.` };
        return { content: `${tool} did not finish: ${result.text}.`, isError: true, effect: result.sent ? 'unknown' : 'none' };
      },
    }),
    defineTool({
      name: name('calendar_list_events'),
      description: 'List calendar events between two times (ISO 8601 with an offset). account all merges every account.',
      input: z.object({ account: anyAccount, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
      risk: 'read',
      untrustedOutput: 'calendar',
      source: GOOGLE,
      serverId: GOOGLE,
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
    defineTool({
      name: name('calendar_freebusy'),
      description: 'Show the busy times between two times (ISO 8601 with an offset).',
      input: z.object({ account: anyAccount, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
      risk: 'read',
      untrustedOutput: 'calendar',
      source: GOOGLE,
      serverId: GOOGLE,
      run: ({ account: which, from, to }) =>
        eachAccount(name('calendar_freebusy'), which, 'calendar', async (apis, alias) => {
          const { data } = await apis.calendar.freebusy.query({ requestBody: { timeMin: from, timeMax: to, items: [{ id: 'primary' }] } });
          return (data.calendars?.primary?.busy ?? []).map((busy) => `[${alias}] busy ${busy.start} to ${busy.end}`);
        }),
    }),
    defineTool({
      name: name('calendar_create_event'),
      description: 'Create an event on the owner\'s own calendar. It invites nobody; use calendar_update_event to add attendees.',
      input: z.object({
        account,
        summary: z.string().min(1).max(500),
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
      }),
      risk: 'write',
      source: GOOGLE,
      serverId: GOOGLE,
      async run(input, ctx) {
        // the id comes from the call, so a second run of the same approved call finds the first event instead of a
        // copy. hex digits are valid base32hex, which google needs for an event id.
        const id = `okc${createHash('sha256').update(`${ctx.runId}:${ctx.toolCallId ?? ''}`).digest('hex').slice(0, 32)}`;
        const tool = name('calendar_create_event');
        try {
          const { data } = await accounts.run(input.account, (apis) =>
            apis.calendar.events.insert({
              calendarId: 'primary',
              sendUpdates: 'none',
              requestBody: {
                id,
                summary: input.summary,
                start: { dateTime: input.start },
                end: { dateTime: input.end },
                ...(input.description ? { description: input.description } : {}),
                ...(input.location ? { location: input.location } : {}),
              },
            }),
          );
          return { content: `created event ${data.id} in ${input.account}.` };
        } catch (err) {
          const error = toGoogleError(err);
          if (error.status === 409) return { content: `the event ${id} already exists in ${input.account}, so this call made it before.` };
          return failed(tool, input.account, error, true);
        }
      },
    }),
    defineTool({
      name: name('calendar_update_event'),
      description: 'Change an event. attendees replaces the attendee list, and google sends each attendee an update. The owner approves each call.',
      input: z.object({
        account,
        eventId: z.string().min(1).max(1024),
        summary: z.string().max(500).optional(),
        start: z.iso.datetime({ offset: true }).optional(),
        end: z.iso.datetime({ offset: true }).optional(),
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
        attendees: addresses.optional(),
      }),
      risk: 'external',
      needsApproval: true,
      source: GOOGLE,
      serverId: GOOGLE,
      async run({ account: alias, eventId, attendees, start, end, ...fields }) {
        const bad = attendees ? badAddress(attendees) : undefined;
        if (bad !== undefined) return { content: `${JSON.stringify(bad)} is not a plain email address.`, isError: true, effect: 'none' };
        return write(name('calendar_update_event'), alias, async (apis) => {
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
          return `updated event ${eventId} in ${alias}.`;
        });
      },
    }),
    defineTool({
      name: name('calendar_delete_event'),
      description: 'Delete an event. Google tells its attendees. The owner approves each call.',
      input: z.object({ account, eventId: z.string().min(1).max(1024) }),
      risk: 'external',
      needsApproval: true,
      source: GOOGLE,
      serverId: GOOGLE,
      async run({ account: alias, eventId }) {
        try {
          await accounts.run(alias, (apis) => apis.calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' }));
          return { content: `deleted event ${eventId} in ${alias}.` };
        } catch (err) {
          const error = toGoogleError(err);
          // a delete that comes again after a lost answer finds the event gone. that is the result that the owner wanted.
          if (error.kind === 'gone' || error.kind === 'not_found') return { content: `the event ${eventId} is already deleted in ${alias}.` };
          return failed(name('calendar_delete_event'), alias, error, true);
        }
      },
    }),
  ];

  if (config.send) {
    tools.push(
      defineTool({
        name: name('gmail_send'),
        description: 'Send an email. Recipients are plain addresses in lists. The owner approves each call.',
        input: z.object({
          account,
          to: addresses.min(1),
          cc: addresses.optional(),
          bcc: addresses.optional(),
          subject: z.string().max(500),
          body: z.string().max(100_000),
          threadId: z.string().max(100).optional(),
          inReplyTo: z.string().max(500).optional(),
        }),
        risk: 'external',
        needsApproval: true,
        source: GOOGLE,
        serverId: GOOGLE,
        run: ({ account: alias, ...draft }) => sendDraft(name('gmail_send'), alias, draft),
      }),
    );
  }
  return tools;
}

// the text of a message: the first text/plain part, or the text/html part without its tags.
function bodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  const plain = findPart(part, 'text/plain');
  if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64url').toString('utf8');
  const html = findPart(part, 'text/html');
  if (html?.body?.data) {
    return Buffer.from(html.body.data, 'base64url')
      .toString('utf8')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ');
  }
  return '(no text part)';
}

function findPart(part: gmail_v1.Schema$MessagePart | undefined, mimeType: string): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
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
