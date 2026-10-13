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

export type SlackPage = { ok: true; messages: SlackMessage[] } | { ok: false; reason: string };

export interface SlackDmPollDeps {
  db: Db;
  blobs: BlobStore;
  logger: Logger;
  clock: Clock;
  connection(integrationId: string): McpConnection | undefined;
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
    const outcome = await connection.callTool(tool, args, { runId: null, toolCallId });
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
      `INSERT INTO integration_events (source, account, externalId, kind, summary, payloadBlob, untrustedSource, occurredAt, seenAt)
       VALUES ('slack', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, account, externalId) DO NOTHING`,
    );
    let added = 0;
    db.exec('BEGIN');
    try {
      messages.forEach((message, i) => {
        const kind = state.selfId !== null && message.user === state.selfId ? 'dm_reply' : 'dm';
        // the redaction comes before the cut, so a secret on the cut is never stored in part.
        const summary = headOf(redact(`${message.user ?? 'unknown user'} in ${message.channel}: ${message.text.replace(/\s+/g, ' ').trim()}`), SUMMARY_LIMIT);
        const occurredAt = new Date(Number(message.ts) * 1000).toISOString();
        added += Number(insert.run(id, `${message.channel}:${message.ts}`, kind, summary, blobs[i]!, `mcp:${id}`, occurredAt, now.toISOString()).changes);
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
    for (let page = 1; page <= PAGES_PER_POLL; page++) {
      const step = await call(id, connection, SEARCH_TOOL, searchArgs(after));
      if (!step.ok) return step.job;
      const answer = readSearchPage(step.result);
      if (!answer.ok) return unreadable(id, step, answer.reason);
      const { messages } = answer;
      const full = messages.length >= PAGE_SIZE;
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
      // keyset paging: the next page starts in the second of the newest message of this page. more than a full page in
      // one second moves on to the next second, and the log says so.
      const next = Math.floor(Number(newest(null, messages) ?? after));
      if (next <= after) logger.warn('slack poll moved past a second with a full page', { integration: id, after });
      after = next <= after ? after + 1 : next;
    }
    logger.info('slack poll', { integration: id, read, added, complete: state.complete });
    return { status: 'completed' };
  };
}

// the search needs a word or a filter. slack reads the day of after: in the time zone of the user, so the filter has
// one day of margin, and the after field gives the exact second.
export function searchArgs(after: number): Record<string, unknown> {
  return {
    filters: `after:${new Date((after - 24 * 60 * 60) * 1000).toISOString().slice(0, 10)}`,
    channel_types: 'im,mpim',
    after: String(after),
    sort: 'timestamp',
    sort_dir: 'asc',
    limit: PAGE_SIZE,
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
const LABELED_TS = /\b(?:message_ts|msg_?id|ts)\b["'*\s:=]*(\d{9,10}\.\d{6})\b/i;
// d is a dm, g an older private group or a group dm, and c a channel. a slack id has upper case letters and digits. so
// the id patterns have no i flag, and they need a digit, because a name in capitals such as GREGORYSMITH is not an id.
const id = (first: string) => `\\b([${first}](?=[A-Z0-9]*\\d)[A-Z0-9]{8,})\\b`;
const CHANNEL = new RegExp(id('CDG'));
const USER = new RegExp(id('UW'));
// only the label can be in upper or lower case. a name on the line, as in "From: Christopher (U0...)", is not the id.
const CHANNEL_LINE = new RegExp(`\\b[Cc]hannel\\b[^\\n]*?${id('CDG')}`);
const USER_LINE = new RegExp(`\\b(?:[Ff]rom|[Uu]ser|[Aa]uthor)\\b[^\\n]*?${id('UW')}`);
const USER_ID_LINE = new RegExp(`\\b[Uu]ser[ _]?(?:id|Id|ID)\\b[^\\n]*?${id('UW')}`);
const HEADING = /^\s*#{1,6}\s+\S/;
const NOTHING = /\bno (?:results|messages|matches)\b|\b0 (?:results|messages|matches)\b|^\s*$/i;

// readSearchPage takes structured content or json first, because those keep their shape when the server changes its
// words. markdown text is the last way.
export function readSearchPage(result: CallToolResult): SlackPage {
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
      return messagesInMarkdown(text);
    }
    // json without a list that the reader knows is unreadable. the markdown reader would see all of it as one message.
    return messagesInJson(parsed) ?? { ok: false, reason: 'it is json without a list of messages that the reader knows' };
  }
  return messagesInMarkdown(text);
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
// other line is text of the block before it. thus a dm cannot cut a block or add one at a wrong place. a dm that
// guesses the next number can put a false block in place of the next real result, whose text then stays in that block.
function messagesInMarkdown(text: string): SlackPage {
  if (!HAS_TS.test(text)) return NOTHING.test(text) ? { ok: true, messages: [] } : { ok: false, reason: 'it has no message that the reader knows' };
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => HEADING.test(line));
  const numberOf = first < 0 || HAS_TS.test(lines.slice(0, first).join('\n')) ? undefined : headingForm(lines[first]!);
  if (!numberOf) return { ok: false, reason: 'it has no numbered heading before its first message' };
  // a count before the first heading, as in "Found 3 results.", is the number of blocks. a block after the last one is
  // text of a dm, and a wrong count means that the reader does not know this form.
  const count = /\b(\d+) (?:results|messages|matches)\b/i.exec(lines.slice(0, first).join('\n'));
  const total = count ? Number(count[1]) : Infinity;
  const blocks: string[][] = [];
  for (const line of lines.slice(first)) {
    if (blocks.length < total && numberOf(line) === blocks.length + 1) blocks.push([]);
    else blocks.at(-1)!.push(line);
  }
  if (count && blocks.length !== total) return { ok: false, reason: 'its number of results is not the number of blocks' };
  const messages: SlackMessage[] = [];
  for (const lines of blocks) {
    // the fields of the server come before the text of the dm, so the first match of a field is the one of the server.
    // a heading before the ts is not text of a dm. it shows that the first heading was not the form of a result.
    const at = lines.findIndex((line) => LABELED_TS.test(line));
    if (at < 0) return { ok: false, reason: 'a message has no labeled ts' };
    if (lines.slice(0, at).some((line) => HEADING.test(line))) return { ok: false, reason: 'a message has a heading before its ts' };
    const block = lines.join('\n');
    const ts = LABELED_TS.exec(lines[at]!)![1]!;
    const channel = CHANNEL_LINE.exec(block)?.[1] ?? CHANNEL.exec(block)?.[1];
    if (!channel) return { ok: false, reason: 'a message has no channel id' };
    const user = USER_LINE.exec(block)?.[1] ?? USER.exec(block)?.[1];
    messages.push({ channel, ts, ...(user ? { user } : {}), text: block.trim() });
  }
  return { ok: true, messages };
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
