import { createHash } from 'node:crypto';
import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import { z } from 'zod';
import type { Logger } from '../observability/logger.js';
import { cleanLine } from '../signals/store.js';
import { headOf } from '../text.js';
import { zonedToUtc } from '../time.js';
import { defineTool, type Tool, type ToolOutput } from '../tools/registry.js';
import type { GoogleAccounts, GoogleApis } from './accounts.js';
import type { GoogleConfig } from './config.js';
import { GoogleError, toGoogleError } from './errors.js';
import { badAddress, bodyText, header, rawMessage } from './mime.js';
import { failed } from './failed.js';
import { sendDraft } from './send.js';
import { requestContext } from './trace.js';
import { oneClick as realOneClick, planUnsubscribe, unsubscribeTargets, type OneClickResult } from './unsubscribe.js';


// the time of an event for its line: the start, then the end. the start comes first, because the merged list sorts by
// it. google gives an all-day event the next day as its end, so the line names the last day of the event.
function whenOf(event: { start?: { dateTime?: string | null; date?: string | null }; end?: { dateTime?: string | null; date?: string | null } }): string {
  const start = event.start?.dateTime ?? event.start?.date ?? 'unknown start';
  if (event.start?.dateTime) return event.end?.dateTime ? `${start} to ${event.end.dateTime}` : start;
  const end = event.end?.date;
  if (!end) return `${start} all day`;
  const last = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return last > start ? `${start} to ${last} all day` : `${start} all day`;
}

// gmail gives a snippet with html entities, and a newsletter pads its preview with invisible characters.
function snippetOf(snippet: string | null | undefined): string {
  return plainText((snippet ?? '').replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code) > 0x10ffff ? 0xfffd : Number(code))))
    .replace(/[\u034f\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// the state of a message that an assistant cares about: unread, starred, important, and whether files came with it.
// a search reads only the headers, so a multipart/mixed message counts as one with files.
function flagsOf(message: gmail_v1.Schema$Message): string[] {
  const labels = message.labelIds ?? [];
  const files = /^multipart\/mixed/i.test(header(message, 'Content-Type')) || attachmentsOf(message.payload).length > 0;
  return [
    ...(labels.includes('UNREAD') ? ['unread'] : []),
    ...(labels.includes('STARRED') ? ['starred'] : []),
    ...(labels.includes('IMPORTANT') ? ['important'] : []),
    ...(files ? ['has attachments'] : []),
  ];
}

// the files of a message: the name, the type and the size of each part that has a file name.
function attachmentsOf(part: gmail_v1.Schema$MessagePart | undefined, found: string[] = []): string[] {
  if (!part) return found;
  if (part.filename) found.push(`${cleanLine(part.filename, 200)} (${part.mimeType ?? 'unknown type'}, ${Math.max(1, Math.round((part.body?.size ?? 0) / 1024))} KB)`);
  for (const child of part.parts ?? []) attachmentsOf(child, found);
  return found;
}

// the text of an event description. a calendar app writes it in html, and the sender of an invitation writes it, so
// each step takes linear time and the text stays untrusted.
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// a person on an event: the name when google has one, and the address.
const personOf = (person: { email?: string | null; displayName?: string | null }) =>
  person.displayName ? `${person.displayName} <${person.email ?? 'no address'}>` : (person.email ?? 'someone');

// google names the answers needsAction, accepted, tentative and declined. the line uses words.
const ANSWER: Record<string, string> = { needsAction: 'not answered', accepted: 'accepted', tentative: 'maybe', declined: 'declined' };
const answerOf = (status: string | null | undefined) => ANSWER[status ?? 'needsAction'] ?? status ?? 'not answered';

// the video link of an event: a meet link, or the video entry point of another conference tool.
// a zoom invitation often puts its link in the location, so a location that is a link counts as the video link.
const isLink = (text: string | null | undefined) => /^https?:\/\/\S+$/i.test((text ?? '').trim());
const videoOf = (event: calendar_v3.Schema$Event) =>
  event.hangoutLink ??
  event.conferenceData?.entryPoints?.find((point) => point.entryPointType === 'video')?.uri ??
  (isLink(event.location) ? event.location!.trim() : undefined);

// a meeting with many guests gets a count of the answers. a list of six names out of 46 tells the owner nothing.
const MANY_GUESTS = 8;
function guestsOf(guests: calendar_v3.Schema$EventAttendee[]): string | undefined {
  if (!guests.length) return undefined;
  if (guests.length > MANY_GUESTS) {
    const counts = new Map<string, number>();
    for (const each of guests) counts.set(answerOf(each.responseStatus), (counts.get(answerOf(each.responseStatus)) ?? 0) + 1);
    return `${guests.length} guests: ${[...counts].map(([answer, count]) => `${count} ${answer}`).join(', ')}`;
  }
  return `${guests.length} guests: ${guests.map((each) => `${personOf(each)} ${answerOf(each.responseStatus)}`).join(', ')}`;
}

// one line for each event, so a day reads at a glance: the time, the title, where, the video link, the owner's own
// answer, the guests and their answers, and the first words of the description. calendar_get_event gives the rest.
function eventLine(event: calendar_v3.Schema$Event, label: string): string {
  const guests = (event.attendees ?? []).filter((each) => !each.self && !each.resource);
  const rooms = (event.attendees ?? []).filter((each) => each.resource).map((each) => each.displayName ?? each.email);
  const own = (event.attendees ?? []).find((each) => each.self);
  const where = [isLink(event.location) ? null : event.location, ...rooms].filter(Boolean).join('; ');
  const video = videoOf(event);
  const guestText = guestsOf(guests);
  const notes = event.description ? cleanLine(plainText(event.description), 160) : '';
  const parts = [
    `${whenOf(event)} [${label}] id=${event.id} ${event.summary ?? '(no title)'}${event.organizer?.self ? '' : ` (from ${event.organizer?.email ?? 'someone'})`}`,
    ...(event.eventType && event.eventType !== 'default' ? [`type ${event.eventType}`] : []),
    ...(event.status === 'tentative' ? ['tentative'] : []),
    ...(where ? [`at ${where}`] : []),
    ...(video ? [`video ${video}`] : []),
    ...(own && !event.organizer?.self ? [`you: ${answerOf(own.responseStatus)}`] : []),
    ...(guestText ? [guestText] : []),
    ...(event.transparency === 'transparent' ? ['shows as free'] : []),
    ...(event.recurringEventId ? ['repeats'] : []),
    ...(notes ? [`notes: ${notes}`] : []),
  ];
  return cleanLine(parts.join(' | '), 900);
}

// every detail of one event, for calendar_get_event.
function eventDetail(event: calendar_v3.Schema$Event, label: string): string {
  const own = (event.attendees ?? []).find((each) => each.self);
  const video = videoOf(event);
  const lines = [
    `${event.summary ?? '(no title)'} [${label}] id=${event.id}`,
    `when: ${whenOf(event)}${event.start?.timeZone ? ` (${event.start.timeZone})` : ''}`,
    ...(event.status && event.status !== 'confirmed' ? [`status: ${event.status}`] : []),
    ...(event.eventType && event.eventType !== 'default' ? [`type: ${event.eventType}`] : []),
    ...(event.location && !isLink(event.location) ? [`where: ${cleanLine(event.location, 500)}`] : []),
    ...(video ? [`video: ${video}`] : []),
    ...(event.conferenceData?.entryPoints ?? [])
      .filter((point) => point.entryPointType === 'phone')
      .map((point) => `phone: ${point.uri ?? point.label}${point.pin ? ` pin ${point.pin}` : ''}`),
    `organizer: ${event.organizer?.self ? 'the owner' : personOf(event.organizer ?? {})}`,
    ...(own ? [`the owner's answer: ${answerOf(own.responseStatus)}`] : []),
    ...(event.transparency === 'transparent' ? ['shows as free'] : []),
    ...(event.recurringEventId ? [`repeats (series ${event.recurringEventId})`] : []),
    ...(event.recurrence?.length ? [`rule: ${event.recurrence.join('; ')}`] : []),
    ...(event.attendees?.length
      ? ['guests:', ...event.attendees.map((each) => `- ${personOf(each)}: ${answerOf(each.responseStatus)}${each.organizer ? ', organizer' : ''}${each.optional ? ', optional' : ''}${each.resource ? ', room' : ''}${each.self ? ', the owner' : ''}`)]
      : []),
    ...(event.attachments?.length ? ['files:', ...event.attachments.map((file) => `- ${cleanLine(file.title ?? 'file', 200)} ${file.fileUrl ?? ''}`.trim())] : []),
    ...(event.htmlLink ? [`link: ${event.htmlLink}`] : []),
    ...(event.description ? ['', headOf(plainText(event.description).replace(/[ \t]+/g, ' ').trim(), 8_000)] : []),
  ];
  return lines.join('\n');
}

// the calendars of an account that the owner shows in google calendar. the primary one comes first. a list that
// fails gives the primary calendar alone, so a read still works.
async function shownCalendars(apis: GoogleApis): Promise<Array<{ id: string; label: string | null }>> {
  try {
    const { data } = await apis.calendar.calendarList.list({ minAccessRole: 'reader', maxResults: 250 });
    const others = (data.items ?? [])
      .filter((each) => !each.primary && each.selected && !each.hidden && each.id)
      .map((each) => ({ id: each.id!, label: cleanLine(each.summaryOverride ?? each.summary ?? each.id!, 60) }));
    return [{ id: 'primary', label: null }, ...others];
  } catch {
    return [{ id: 'primary', label: null }];
  }
}
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

  // a read tool runs on each account that it names. one account that fails does not hide the others. with all, an
  // account that cannot take a call gets a line that says so, so the answer does not read as if it was checked.
  const eachAccount = async (tool: string, which: string, source: 'gmail' | 'calendar', work: (apis: GoogleApis, alias: string) => Promise<string[]>): Promise<ToolOutput> => {
    const targets = which === 'all' ? aliases.filter((alias) => !accounts.unavailable(alias)) : [which];
    const skipped = which === 'all' ? aliases.filter((alias) => !targets.includes(alias)).map((alias) => `[${alias}] not checked: ${accounts.unavailable(alias)}`) : [];
    if (!targets.length) return { content: [`${tool}: no google account is signed in.`, ...skipped].join('\n'), isError: true };
    const parts = await Promise.all(
      targets.map(async (alias) => {
        try {
          return { alias, lines: await accounts.run(alias, (apis) => work(apis, alias)) };
        } catch (err) {
          return { alias, error: failed(tool, alias, toGoogleError(err), false).content };
        }
      }),
    );
    const content = [...parts.map((part) => ('error' in part ? part.error! : part.lines!.length ? part.lines!.join('\n') : `[${part.alias}] nothing found`)), ...skipped].join('\n');
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
      // only the read failed, and the change did not leave. so the effect is none, and the owner can approve again.
      throw new GoogleError(error.kind, error.message, error.status, false);
    }
    if (event.status === 'cancelled') return 'gone';
    if ((event.summary ?? '') === currentTitle) return undefined;
    // the refusal does not quote the title. the sender of an invitation writes it, and this output is not marked as
    // untrusted. calendar_list_events shows it.
    return { content: `${tool} did not run: the event ${eventId} has another title now, not ${JSON.stringify(currentTitle)}. calendar_list_events shows its title.`, isError: true };
  };

  const messageIds = z.array(z.string().min(1).max(100)).min(1).max(100);

  const tools: Tool[] = [
    googleTool({
      name: name('gmail_search'),
      description:
        'Search Gmail with Gmail search syntax (for example "from:school is:unread newer_than:7d"). Gives the id, thread, date, sender, recipients, subject, whether it is unread, starred or important, whether it has attachments, and the first words of each message.',
      input: z.object({ account: anyAccount, query: z.string().max(500), max: z.number().int().min(1).max(MAX_RESULTS).default(10) }),
      risk: 'read',
      untrustedOutput: 'gmail',
      run: ({ account: which, query, max }) =>
        eachAccount(name('gmail_search'), which, 'gmail', async (apis, alias) => {
          const list = await apis.gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
          const messages = await Promise.all(
            (list.data.messages ?? []).map((each) =>
              apis.gmail.users.messages.get({ userId: 'me', id: each.id!, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'Content-Type'] }),
            ),
          );
          return messages.map(({ data }) =>
            cleanLine(
              [
                `[${alias}] id=${data.id} thread=${data.threadId} ${header(data, 'Date')}`,
                header(data, 'From'),
                `to ${cleanLine([header(data, 'To'), header(data, 'Cc')].filter(Boolean).join(', '), 160) || 'no one'}`,
                header(data, 'Subject'),
                ...flagsOf(data),
                snippetOf(data.snippet),
                ...(header(data, 'List-Unsubscribe') ? ['can unsubscribe'] : []),
              ].join(' | '),
              800,
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
                ...(flagsOf(message).length ? [`State: ${flagsOf(message).join(', ')}`] : []),
                ...attachmentsOf(message.payload).map((file) => `Attachment: ${file}`),
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
      description: 'Add or remove Gmail labels (by label id) on messages. It cannot add TRASH or SPAM.',
      // the owner can allow this tool without approval, also after the agent read mail. the trash deletes mail for good
      // after 30 days, and spam hides it, so text in one mail could else make the agent remove the inbox.
      input: z.object({
        account,
        messageIds,
        add: z.array(z.string().max(100).refine((id) => !['TRASH', 'SPAM'].includes(id.toUpperCase()), 'gmail_label cannot add TRASH or SPAM')).default([]),
        remove: z.array(z.string().max(100)).default([]),
      }),
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
          const metadataHeaders = ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Authentication-Results', 'DKIM-Signature'];
          message = (await accounts.run(alias, (apis) => apis.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders }))).data;
        } catch (err) {
          return { ...failed(tool, alias, toGoogleError(err), true), effect: 'none' };
        }
        // the owner approved this sender and this target, so the message must still name both. a refusal has no
        // effect field: a second approval of the same call cannot help.
        const plan = planUnsubscribe(message, sender, target, config.send);
        if (plan.way === 'refused') return { content: `${tool} did not run: ${plan.text}.`, isError: true };
        if (plan.way === 'mailto') return sendDraft(accounts, tool, alias, { to: [plan.to], subject: plan.subject, body: plan.body });
        // the post goes outside accounts.run, so the trace gets the account here. without it the row had no account.
        const result = await requestContext.run({ ...requestContext.getStore(), account: alias }, () => oneClick(target));
        if (result.ok) return { content: `unsubscribed: ${result.text}.` };
        return { content: `${tool} did not finish: ${result.text}.`, isError: true, ...(result.refused ? {} : { effect: result.sent ? 'unknown' : 'none' }) };
      },
    }),
    googleTool({
      name: name('calendar_list_events'),
      description:
        'List calendar events between two times (ISO 8601 with an offset), from every calendar that the owner shows. Each line gives the start and the end, where, the video link, the owner\'s answer, the guests and their answers, and the first words of the notes. account all merges every account. calendar_get_event gives every detail of one event.',
      input: z.object({ account: anyAccount, from: time, to: time }),
      risk: 'read',
      untrustedOutput: 'calendar',
      run: async ({ account: which, from, to }, ctx) => {
        const output = await eachAccount(name('calendar_list_events'), which, 'calendar', async (apis, alias) => {
          const calendars = await shownCalendars(apis);
          const lists = await Promise.all(
            calendars.map(async (calendar) => {
              const { data } = await apis.calendar.events.list({ calendarId: calendar.id, timeMin: from, timeMax: to, singleEvents: true, orderBy: 'startTime', maxResults: 100 });
              return (data.items ?? []).map((event) => ({ event, calendar }));
            }),
          );
          // an invitation from a shared calendar is also on the primary one. the first copy, from the primary
          // calendar, stays.
          const seen = new Set<string>();
          const used = new Set<(typeof calendars)[number]>();
          const events = lists.flat().flatMap(({ event, calendar }) => {
            const key = `${event.iCalUID ?? event.id}@${event.start?.dateTime ?? event.start?.date}`;
            if (seen.has(key)) return [];
            seen.add(key);
            used.add(calendar);
            return [eventLine(event, calendar.label ? `${alias}/${calendar.label}` : alias)];
          });
          // the id of each other calendar comes once, for calendar_get_event, and not on each line.
          const legend = [...used].filter((each) => each.label);
          return legend.length ? [...events, `[${alias}] calendar ids: ${legend.map((each) => `${each.label} = ${each.id}`).join('; ')}`] : events;
        });
        // the lines of all accounts sort by time, so a merged list reads as one day. google writes each start in the
        // zone of its calendar, so the sort uses the time and not the text. an all-day event starts at midnight in the
        // owner's zone. a line without a time (an error, or an account without events) comes after the events.
        const at = (line: string) => {
          const start = line.slice(0, line.indexOf(' '));
          const time = /^\d{4}-\d{2}-\d{2}$/.test(start) ? zonedToUtc(start, '00:00', ctx.timeZone).getTime() : Date.parse(start);
          return Number.isNaN(time) ? Infinity : time;
        };
        const lines = output.content.split('\n').map((line) => ({ line, time: at(line) }));
        lines.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? -1 : 1));
        return { ...output, content: lines.map((each) => each.line).join('\n') };
      },
    }),
    googleTool({
      name: name('calendar_get_event'),
      description:
        'Read every detail of one calendar event: the time, where, the video and phone links, the organizer, each guest and their answer, the files and the full notes. calendarId is only for an event of a calendar that is not the primary one; calendar_list_events gives it in its calendar ids line.',
      input: z.object({ account, eventId: z.string().min(1).max(1024), calendarId: z.string().min(1).max(500).optional() }),
      risk: 'read',
      untrustedOutput: 'calendar',
      run: ({ account: alias, eventId, calendarId }) =>
        eachAccount(name('calendar_get_event'), alias, 'calendar', async (apis) => {
          const { data } = await apis.calendar.events.get({ calendarId: calendarId ?? 'primary', eventId });
          return [eventDetail(data, calendarId ? `${alias} calendar=${calendarId}` : alias)];
        }),
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
    'calendar_get_event',
    'calendar_freebusy',
    'calendar_create_event',
    'calendar_update_event',
    'calendar_delete_event',
  ].map(name);
}

const READ_TOOLS = ['gmail_search', 'gmail_read_thread', 'gmail_list_labels', 'calendar_list_events', 'calendar_get_event', 'calendar_freebusy'].map(name);

// the tools of a session profile. an automation with auto-read can check mail and the calendar, but it cannot change
// them, also when a mail that it reads asks for that.
export function googleToolsFor(config: Pick<GoogleConfig, 'send' | 'sessions'>, profile: string): string[] {
  const all = googleToolNames(config);
  if (profile === 'main') return config.sessions.includes('main') ? all : [];
  if (profile === 'auto') {
    if (config.sessions.includes('auto')) return all;
    if (config.sessions.includes('auto-read')) return all.filter((each) => READ_TOOLS.includes(each));
  }
  return [];
}
