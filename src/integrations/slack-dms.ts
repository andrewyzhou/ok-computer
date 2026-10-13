import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redact } from '../observability/redact.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { headOf } from '../text.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import { resultText } from './discovery.js';
import type { McpConnection } from './mcp.js';

// the dm poll of the official slack server. it is code, not a model call. each call goes through the connection of the
// integration, so mcp_messages has every request and every raw answer. the position is a slack ts, which a clock that
// moves cannot change, and it is written in the same transaction as the signals of each page.

export const SEARCH_TOOL = 'slack_search_public_and_private';
export const PROFILE_TOOL = 'slack_read_user_profile';
// the search index of slack can show a message some time after it was sent. a poll after a complete poll reads this
// far back again, and the unique key drops what it already stored.
export const OVERLAP_S = 10 * 60;
// the first poll of a workspace reads the last day, so a dm that waits since yesterday becomes a signal too.
export const FIRST_LOOKBACK_S = 24 * 60 * 60;
// the official search gives at most 20 results a page.
export const PAGE_SIZE = 20;
// one poll reads at most this many pages. the next poll goes on from the position.
export const PAGES_PER_POLL = 10;
// the calls of a poll only read, and the next poll reads again. so a poll does not wait the long answer limit of a tool
// call. a server that never answers would hold the poll, and the scheduler would start the next poll beside it.
export const POLL_ANSWER_WAIT_MS = 60_000;
const SUMMARY_LIMIT = 300;

interface PollState {
  position: string | null;
  // false when the last poll stopped at its page limit.
  complete: boolean;
  // the slack user id of the owner. a message from this id is a dm_reply.
  selfId: string | null;
}

export interface SlackMessage {
  channel: string;
  // the slack timestamp, for example 1760371921.123456. it is the id of the message in its channel.
  ts: string;
  user?: string;
  text: string;
}

// onlyFirst is true when the text of a dm can have made or cut a block. then only the first message is certainly the
// server's, and messages holds only that one. the blocks before block suspect are whole, but one of them can still be
// false, so a page with a smaller limit must read them again.
export type SlackPage = { ok: true; messages: SlackMessage[]; onlyFirst?: { suspect: number } } | { ok: false; reason: string };

export interface SlackDmPollDeps {
  db: Db;
  blobs: BlobStore;
  logger: Logger;
  clock: Clock;
  connection(integrationId: string): McpConnection | undefined;
  // a test gives a shorter wait. the default is POLL_ANSWER_WAIT_MS.
  answerWaitMs?: number;
}

type Step = { ok: true; result: CallToolResult; where: string } | { ok: false; job: JobResult };

export const pollStateKey = (integrationId: string) => `slack-poll:${integrationId}`;

export function createSlackDmPoll(deps: SlackDmPollDeps): (integrationId: string) => Promise<JobResult> {
  const { db, logger, clock } = deps;

  // the error of a job goes to automation_runs and, after five failures, to the owner. so it names the tool and the
  // call, and never quotes the answer, which is outside text. the json-rpc rows of the call keep the answer.
  const call = async (id: string, connection: McpConnection, tool: string, args: Record<string, unknown>): Promise<Step> => {
    const toolCallId = `poll:${id}:${randomUUID()}`;
    const where = `${tool} (call ${toolCallId})`;
    const outcome = await connection.callTool(tool, args, { runId: null, toolCallId }, { answerWaitMs: deps.answerWaitMs ?? POLL_ANSWER_WAIT_MS });
    switch (outcome.kind) {
      case 'result':
        if (!outcome.result.isError) return { ok: true, result: outcome.result, where };
        return { ok: false, job: { status: 'failed', error: `${where} answered with an error. Its JSON-RPC messages on the Integrations page show it.` } };
      case 'not_sent':
        // the call did not leave, so the connection state says why. the page shows that state.
        return { ok: false, job: { status: 'skipped', error: `${where} was not sent, because ${id} is not connected now.` } };
      case 'refused':
        return { ok: false, job: { status: 'failed', error: `${where} was refused with JSON-RPC error ${outcome.code}.` } };
      case 'unknown':
        return { ok: false, job: { status: 'failed', error: `${where} got no answer that the app could read.` } };
    }
  };

  const unreadable = (id: string, step: { result: CallToolResult; where: string }, reason: string): JobResult => {
    // the log stays on the pc, so it can hold the start of the answer for the owner who fixes the reader.
    logger.warn('slack poll could not read an answer', { integration: id, reason, start: headOf(redact(resultText(step.result)), 200) });
    return { status: 'failed', error: `The answer of ${step.where} could not be read: ${reason}. The JSON-RPC messages of the call show the raw answer.` };
  };

  // store writes the messages of one page and the new state in one transaction. a crash before the commit leaves the
  // old position, so the next poll reads the page again, and the unique key drops what was stored.
  const store = (id: string, messages: SlackMessage[], state: PollState): number => {
    const now = clock();
    const blobs = messages.map((message) => deps.blobs.put(message.text, 'text/plain; charset=utf-8'));
    const insert = db.prepare(
      `INSERT INTO integration_events (source, account, externalId, kind, summary, payloadBlob, untrustedSource, occursAt, seenAt)
       VALUES ('slack', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, account, externalId) DO NOTHING`,
    );
    let added = 0;
    db.exec('BEGIN');
    try {
      messages.forEach((message, i) => {
        const kind = state.selfId !== null && message.user === state.selfId ? 'dm_reply' : 'dm';
        // the redaction comes before the cut, so a secret on the cut is never stored in part.
        const summary = headOf(redact(`${message.user ?? 'unknown user'} in ${message.channel}: ${message.text.replace(/\s+/g, ' ').trim()}`), SUMMARY_LIMIT);
        const occursAt = new Date(Number(message.ts) * 1000).toISOString();
        added += Number(insert.run(id, `${message.channel}:${message.ts}`, kind, summary, blobs[i]!, `mcp:${id}`, occursAt, now.toISOString()).changes);
      });
      setSetting(db, pollStateKey(id), state, now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return added;
  };

  // the text of a dm is in the answer too, so a sender can try to write a message with a ts in the future. a position
  // after the clock makes the overlap of the next poll smaller, and then a dm that the index shows late is lost. so a
  // ts later than the clock never moves the position. the message is still stored as untrusted text.
  const newest = (position: string | null, messages: SlackMessage[]) => {
    const limit = clock().getTime() / 1000;
    return messages.reduce<string | null>(
      (best, message) => (Number(message.ts) <= limit && (best === null || Number(message.ts) > Number(best)) ? message.ts : best),
      position,
    );
  };

  return async (id) => {
    const connection = deps.connection(id);
    const status = connection?.state().status ?? 'stopped';
    if (!connection || status !== 'connected') return { status: 'skipped', error: `${id} is not connected (${status}). The Integrations page says why.` };
    let state = getSetting<PollState>(db, pollStateKey(id)) ?? { position: null, complete: true, selfId: null };
    if (state.selfId === null) {
      const step = await call(id, connection, PROFILE_TOOL, {});
      if (!step.ok) return step.job;
      const selfId = readSelfId(step.result);
      if (!selfId) return unreadable(id, step, 'it has no user id');
      state = { ...state, selfId };
      setSetting(db, pollStateKey(id), state, clock());
    }
    const nowS = Math.floor(clock().getTime() / 1000);
    // after a complete poll the next one reads the overlap again. after a poll that stopped at its page limit, the next
    // one starts at the position, or a burst inside the overlap that is larger than the limit would hold the poll.
    let after = state.position === null ? nowS - FIRST_LOOKBACK_S : Math.floor(Number(state.position)) - (state.complete ? OVERLAP_S : 0);
    let added = 0;
    let read = 0;
    let limit = PAGE_SIZE;
    for (let page = 1; page <= PAGES_PER_POLL; page++) {
      const step = await call(id, connection, SEARCH_TOOL, searchArgs(after, limit));
      if (!step.ok) return step.job;
      const answer = readSearchPage(step.result, limit);
      if (!answer.ok) return unreadable(id, step, answer.reason);
      const { messages } = answer;
      // a page that can hold a false block gives only its first message, so the rest of the page is not read yet. a
      // page of one result has nothing more.
      const cut = limit > 1 ? answer.onlyFirst : undefined;
      const full = cut !== undefined || messages.length >= limit;
      // a full page that is not sorted from old to new can skip the older messages between two pages.
      if (full && !ascending(messages)) return unreadable(id, step, 'a full page is not sorted from old to new, so the next page could skip older messages');
      state = { ...state, position: newest(state.position, messages), complete: !full };
      try {
        added += store(id, messages, state);
      } catch (err) {
        return { status: 'failed', error: `The signals of ${step.where} were not stored: ${errorText(err)}` };
      }
      read += messages.length;
      if (!full) break;
      if (cut && cut.suspect > 2) {
        // the next page reads from the same start, and ends before the first block that the text of a dm can have
        // made. the dm with the false lines is then the last result, and the count or the limit stops its false blocks.
        // false blocks that are whole put suspect far back, so the limit is also at most half of the last one.
        limit = Math.min(cut.suspect - 1, Math.floor(limit / 2));
        continue;
      }
      if (cut) {
        // only the first message is whole. a page from its second gives the same page again, so the next page starts
        // in the second after it. a later dm in that second is skipped, and the log says so.
        logger.warn('slack poll moved past a second after a page with a false block', { integration: id, second: Math.floor(Number(messages[0]!.ts)) });
        after = Math.max(after, Math.floor(Number(messages[0]!.ts))) + 1;
        limit = PAGE_SIZE;
        continue;
      }
      // keyset paging: the next page starts in the second of the newest message of this page. more than a full page in
      // one second moves on to the next second, and the log says so.
      const next = Math.floor(Number(newest(null, messages) ?? after));
      if (next <= after) logger.warn('slack poll moved past a second with a full page', { integration: id, after, limit });
      after = next <= after ? after + 1 : next;
      limit = PAGE_SIZE;
    }
    logger.info('slack poll', { integration: id, read, added, complete: state.complete });
    return { status: 'completed' };
  };
}

// the search needs a word or a filter. slack reads the day of after: in the time zone of the user and gives only the
// later days. west of utc the local day can be one day before the utc day, so one day of margin can leave out the
// evening of the user. two days of margin cover every time zone, and the after field gives the exact second.
export function searchArgs(after: number, limit = PAGE_SIZE): Record<string, unknown> {
  return {
    filters: `after:${new Date((after - 2 * 24 * 60 * 60) * 1000).toISOString().slice(0, 10)}`,
    channel_types: 'im,mpim',
    // the search gives files too. a file result has no message ts, so the reader would fail the page on it.
    content_types: 'messages',
    after: String(after),
    sort: 'timestamp',
    sort_dir: 'asc',
    limit,
    include_context: false,
  };
}

function ascending(messages: SlackMessage[]): boolean {
  return messages.every((message, i) => i === 0 || Number(message.ts) >= Number(messages[i - 1]!.ts));
}

// the answers are text for a model, and their form is not documented. so the reader needs only the two values that the
// poll cannot work without: the channel and the ts of each message. the rest is kept as text. an answer that has text
// but no message that the reader can find is an error, so the position stays and the job fails. a reason never quotes
// the answer.

const TS_VALUE = /^\d{9,10}\.\d{6}$/;
const HAS_TS = /\b\d{9,10}\.\d{6}\b/;
// a field label is only at the start of a line, after markdown such as "- ", "> " or "**". the sender chooses the
// display name on the from line, so a label inside a name, as in "From: Pat ts 1760000000.000000 (U0...)", is not a
// field.
const LEAD = String.raw`^[\s>*_\x60-]*`;
const LABELED_TS = new RegExp(`${LEAD}(?:message_ts|msg_?id|ts)\\b["'*_\\x60\\s:=]*(\\d{9,10}\\.\\d{6})\\b`, 'i');
// d is a dm, g an older private group or a group dm, and c a channel. a slack id has upper case letters and digits. so
// the id patterns have no i flag, and they need a digit, because a name in capitals such as GREGORYSMITH is not an id.
const id = (first: string) => `\\b([${first}](?=[A-Z0-9]*\\d)[A-Z0-9]{8,})\\b`;
const USER = new RegExp(id('UW'));
const CHANNEL_LABEL = new RegExp(`${LEAD}[Cc]hannel\\b`);
const USER_LABEL = new RegExp(`${LEAD}(?:[Ff]rom|[Uu]ser|[Aa]uthor)\\b`);
// only the label can be in upper or lower case. the id of a field is the one at the end of its line, as in
// "From: Christopher (U0...)". the name before it is chosen by a person, and it can hold an id too.
const CHANNEL_LINE = new RegExp(`${id('CDG')}[)>*_\\x60\\s]*$`);
const USER_LINE = new RegExp(`${id('UW')}[)>*_\\x60\\s]*$`);
const USER_ID_LINE = new RegExp(`\\b[Uu]ser[ _]?(?:id|Id|ID)\\b[^\\n]*?${id('UW')}`);
const HEADING = /^\s*#{1,6}\s+\S/;
const NOTHING = /\bno (?:results|messages|matches)\b|\b0 (?:results|messages|matches)\b|^\s*$/i;

// readSearchPage takes structured content or json first, because those keep their shape when the server changes its
// words. markdown text is the last way.
export function readSearchPage(result: CallToolResult, limit = PAGE_SIZE): SlackPage {
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object') {
    const fromJson = messagesInJson(structured);
    if (fromJson) return fromJson;
  }
  const text = resultText(result);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // the text only looks like json. the markdown reader tries it.
      return messagesInMarkdown(text, limit);
    }
    // json without a list that the reader knows is unreadable. the markdown reader would see all of it as one message.
    return messagesInJson(parsed) ?? { ok: false, reason: 'it is json without a list of messages that the reader knows' };
  }
  return messagesInMarkdown(text, limit);
}

// a json answer has a list of objects with a ts. the list can be under any of a few keys, or under messages.matches as
// in the search.messages answer of the slack web api.
function messagesInJson(value: unknown): SlackPage | undefined {
  const root = (value ?? {}) as Record<string, unknown>;
  const nested = (root.messages ?? {}) as Record<string, unknown>;
  const list = Array.isArray(value) ? value : ([root.messages, root.results, root.matches, nested.matches].find(Array.isArray) as unknown[] | undefined);
  if (!list) return undefined;
  const messages: SlackMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'a result in the list is not an object' };
    const each = item as Record<string, unknown>;
    const ts = [each.ts, each.message_ts].find((v): v is string => typeof v === 'string' && TS_VALUE.test(v));
    const value = each.channel_id ?? each.channel;
    const channel = typeof value === 'string' ? value : typeof (value as { id?: unknown })?.id === 'string' ? (value as { id: string }).id : undefined;
    if (!ts || !channel) return { ok: false, reason: 'a result has no ts or no channel' };
    const user = [each.user, each.user_id].find((v): v is string => typeof v === 'string');
    messages.push({ channel, ts, ...(user ? { user } : {}), text: typeof each.text === 'string' ? each.text : JSON.stringify(each) });
  }
  return { ok: true, messages };
}

// a markdown result is a block after a numbered heading of the server, for example "### Result 3 of 20". the text of a
// dm is in the answer too, and it can hold headings, rules and lines that look like a result. so the first heading
// before any ts gives the form of the server, and only a line of that form with the next number starts a block. each
// other line is text of the block before it. thus a rule or another heading in a dm cannot cut a block.
// a dm can hold a line of that form too, and with the next number it starts a false block. the reader cannot tell a
// false block from a real one, but it can see that one exists: the real heading with that number comes later, and its
// number is then not after the blocks so far. a dm in the last result cannot add a block, because the count, or else
// the limit of the page, stops the blocks. a line of the form with a later number is only text. so a page whose lines
// of that form are all real headings or text with a later number is whole. a page with a real heading that a false
// block pushed into text, or with a later block that is not whole, gives only its first message, which is certainly the
// server's, because its heading comes before the text of any dm. suspect is the first block that can be false or cut.
// thus a false block can neither stop the poll nor move its position.
function messagesInMarkdown(text: string, limit: number): SlackPage {
  if (!HAS_TS.test(text)) return NOTHING.test(text) ? { ok: true, messages: [] } : { ok: false, reason: 'it has no message that the reader knows' };
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => HEADING.test(line));
  const numberOf = first < 0 || HAS_TS.test(lines.slice(0, first).join('\n')) ? undefined : headingForm(lines[first]!);
  if (!numberOf) return { ok: false, reason: 'it has no numbered heading before its first message' };
  // a count before the first heading, as in "Found 3 results.", is the number of blocks. a block after the last one is
  // text of a dm, and a wrong count means that the reader does not know this form. without a count, a page has at most
  // the blocks that the poll asks for.
  const count = /\b(\d+) (?:results|messages|matches)\b/i.exec(lines.slice(0, first).join('\n'));
  const total = count ? Number(count[1]) : limit;
  const blocks: string[][] = [];
  let suspect: number | undefined;
  for (const line of lines.slice(first)) {
    const number = numberOf(line);
    if (blocks.length < total && number === blocks.length + 1) blocks.push([]);
    else {
      // the real heading 1 is the first heading, so a later line with the number 1 is always text of a dm. it cannot
      // show a false block, and it must not make the page give only its first message.
      if (number !== undefined && number > 1 && number <= blocks.length) suspect ??= blocks.length;
      blocks.at(-1)!.push(line);
    }
  }
  if (count && blocks.length !== total) return { ok: false, reason: 'its number of results is not the number of blocks' };
  // the first block is the server's, so a fault in it means that the reader does not know this form.
  const head = messageInBlock(blocks[0]!);
  if (typeof head === 'string') return { ok: false, reason: head };
  const messages = [head];
  for (const [i, block] of blocks.entries()) {
    if (i === 0 || (suspect !== undefined && i + 1 >= suspect)) continue;
    const message = messageInBlock(block);
    if (typeof message === 'string') suspect = i + 1;
    else messages.push(message);
  }
  return suspect === undefined ? { ok: true, messages } : { ok: true, messages: [head], onlyFirst: { suspect } };
}

// messageInBlock reads one block, or gives the reason why it cannot. the fields of the server come before the text of
// the dm, so the first line with the label of a field is the one of the server. the id comes only from that line. an id
// on a later line can be text of the dm, which could then give a stranger's dm the id of the owner. so a user line
// without an id, for example a name or a bot, gives no user, and a channel line without an id makes the block not
// whole. a heading before the ts is not text of a dm. it shows that the first heading was not the form of a result.
function messageInBlock(lines: string[]): SlackMessage | string {
  const at = lines.findIndex((line) => LABELED_TS.test(line));
  if (at < 0) return 'a message has no labeled ts';
  if (lines.slice(0, at).some((line) => HEADING.test(line))) return 'a message has a heading before its ts';
  const ts = LABELED_TS.exec(lines[at]!)![1]!;
  const channel = fieldId(lines, CHANNEL_LABEL, CHANNEL_LINE);
  if (!channel) return 'a message has no channel id';
  const user = fieldId(lines, USER_LABEL, USER_LINE);
  return { channel, ts, ...(user ? { user } : {}), text: lines.join('\n').trim() };
}

function fieldId(lines: string[], label: RegExp, field: RegExp): string | undefined {
  const line = lines.find((each) => label.test(each));
  return line === undefined ? undefined : field.exec(line)?.[1];
}

// headingForm reads the form of the first heading, whose first number must be 1. it gives a function that returns the
// first number of a line of the same form, in which only the numbers can change.
function headingForm(heading: string): ((line: string) => number | undefined) | undefined {
  const parts = heading.trim().split(/\d+/);
  if (parts.length < 2 || /\d+/.exec(heading)![0] !== '1') return undefined;
  const form = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\d+)')}$`);
  return (line) => {
    const match = form.exec(line.trim());
    return match ? Number(match[1]) : undefined;
  };
}

// readSelfId reads the user id of the owner from the answer of a profile read.
export function readSelfId(result: CallToolResult): string | undefined {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  for (const key of ['user_id', 'id']) {
    const value = structured?.[key];
    if (typeof value === 'string' && USER.test(value)) return value;
  }
  const text = resultText(result);
  return USER_ID_LINE.exec(text)?.[1] ?? USER.exec(text)?.[1];
}
