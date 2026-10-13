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
// a ts later than the clock plus this skew never moves the position.
export const FUTURE_SKEW_S = 10 * 60;
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

  // the text of a dm is in the answer too, so a sender can write a block that looks like a message with a ts far in
  // the future. a position there would hide every later dm. such a ts never moves the position; the message is still
  // stored as untrusted text.
  const newest = (position: string | null, messages: SlackMessage[]) => {
    const limit = clock().getTime() / 1000 + FUTURE_SKEW_S;
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
const TS = /\b(\d{9,10}\.\d{6})\b/g;
const HAS_TS = /\b\d{9,10}\.\d{6}\b/;
const LABELED_TS = /\b(?:message_ts|msg_?id|ts)\b["'*\s:=]*(\d{9,10}\.\d{6})\b/i;
// d is a dm, g an older private group or a group dm, and c a channel.
const CHANNEL = /\b([CDG][A-Z0-9]{8,})\b/;
const USER = /\b([UW][A-Z0-9]{8,})\b/;
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
    try {
      const fromJson = messagesInJson(JSON.parse(trimmed));
      if (fromJson) return fromJson;
    } catch {
      // the text only looks like json. the markdown reader tries it.
    }
  }
  return messagesInMarkdown(text);
}

// a json answer has a list of objects with a ts. the list can be under any of a few keys.
function messagesInJson(value: unknown): SlackPage | undefined {
  const root = value as Record<string, unknown>;
  const list = Array.isArray(value) ? value : (['messages', 'results', 'matches'].map((key) => root[key]).find(Array.isArray) as unknown[] | undefined);
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

// markdown results are blocks split by headings or rules. a block with a ts is a message.
function messagesInMarkdown(text: string): SlackPage {
  if (!HAS_TS.test(text)) return NOTHING.test(text) ? { ok: true, messages: [] } : { ok: false, reason: 'it has no message that the reader knows' };
  const blocks = text.split(/^\s*(?:#{1,6}\s.*|-{3,}|\*{3,}|_{3,})\s*$/m).filter((block) => HAS_TS.test(block));
  const messages: SlackMessage[] = [];
  for (const block of blocks) {
    // a reply also names the ts of its thread, which is older. without a label the newest ts is the message.
    const ts = LABELED_TS.exec(block)?.[1] ?? [...block.matchAll(TS)].map((match) => match[1]!).sort((a, b) => Number(b) - Number(a))[0]!;
    const channel = /\bchannel\b[^\n]*?\b([CDG][A-Z0-9]{8,})\b/i.exec(block)?.[1] ?? CHANNEL.exec(block)?.[1];
    if (!channel) return { ok: false, reason: 'a message has no channel id' };
    const user = /\b(?:from|user|author)\b[^\n]*?\b([UW][A-Z0-9]{8,})\b/i.exec(block)?.[1] ?? USER.exec(block)?.[1];
    messages.push({ channel, ts, ...(user ? { user } : {}), text: block.trim() });
  }
  return { ok: true, messages };
}

// readSelfId reads the user id of the owner from the answer of a profile read.
export function readSelfId(result: CallToolResult): string | undefined {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  for (const key of ['user_id', 'id']) {
    const value = structured?.[key];
    if (typeof value === 'string' && USER.test(value)) return value;
  }
  const text = resultText(result);
  return /\buser[ _]?id\b[^\n]*?\b([UW][A-Z0-9]{8,})\b/i.exec(text)?.[1] ?? USER.exec(text)?.[1];
}
