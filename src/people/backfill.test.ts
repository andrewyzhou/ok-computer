import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/index.js';
import type { GoogleApis } from '../google/accounts.js';
import { GoogleError } from '../google/errors.js';
import type { Logger } from '../observability/logger.js';
import { BACKFILL_DAYS, BACKFILL_MAX_MESSAGES, backfillStep, sweepSent, type BackfillDeps } from './backfill.js';
import type { PeopleBuilder } from './builder.js';
import type { BackfillState } from './store.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const db = {} as Db;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

// a fake mailbox: count messages, newest first, every third one sent. the page token of messages.list is the offset.
function fakeGoogle(options: { messages: number; events: number; sent?: gmail_v1.Schema$Message[] }) {
  const all: gmail_v1.Schema$Message[] = Array.from({ length: options.messages }, (_, i) => ({
    id: `m${i}`,
    threadId: `t${i}`,
    labelIds: i % 3 === 0 ? ['SENT'] : ['INBOX'],
    internalDate: String(NOW.getTime() - (i + 1) * 60_000),
    payload: { headers: [] },
  }));
  const sent = options.sent ?? [];
  const byId = new Map([...all, ...sent].map((each) => [each.id!, each]));
  const events: calendar_v3.Schema$Event[] = Array.from({ length: options.events }, (_, i) => ({ id: `e${i}` }));
  const calls = { list: [] as Array<{ q: string; maxResults: number; pageToken?: string }>, get: [] as string[], events: [] as Array<Record<string, unknown>> };
  const apis = {
    gmail: {
      users: {
        messages: {
          list: async (params: { q: string; maxResults: number; pageToken?: string }) => {
            calls.list.push(params);
            const source = params.q.startsWith('in:sent') ? sent : all;
            const start = Number(params.pageToken ?? 0);
            const page = source.slice(start, start + params.maxResults);
            const end = start + page.length;
            return { data: { messages: page.map((each) => ({ id: each.id, threadId: each.threadId })), nextPageToken: end < source.length ? String(end) : undefined } };
          },
          get: async (params: { id: string; format: string; metadataHeaders: string[] }) => {
            calls.get.push(params.id);
            expect(params.format).toBe('metadata');
            return { data: byId.get(params.id)! };
          },
        },
      },
    },
    calendar: {
      events: {
        list: async (params: { pageToken?: string; maxResults: number } & Record<string, unknown>) => {
          calls.events.push(params);
          const start = Number(params.pageToken ?? 0);
          const items = events.slice(start, start + 100);
          const end = start + items.length;
          return { data: { items, nextPageToken: end < events.length ? String(end) : undefined } };
        },
      },
    },
  } as unknown as GoogleApis;
  return { apis, calls };
}

function fakeStore(initial: Partial<BackfillState> = {}) {
  let state: BackfillState = {
    account: 'personal',
    backfill: 'pending',
    backfillPage: null,
    backfillMessages: 0,
    backfillEvents: 0,
    backfilledAt: null,
    sentAfter: null,
    error: null,
    ...initial,
  };
  return {
    get state() {
      return state;
    },
    backfillStateOf: vi.fn(() => ({ ...state })),
    saveBackfillState: vi.fn((_db: Db, _account: string, change: Partial<Omit<BackfillState, 'account'>>) => {
      state = { ...state, ...change };
    }),
  };
}

function setup(google: ReturnType<typeof fakeGoogle>, store: ReturnType<typeof fakeStore>, run?: BackfillDeps['accounts']['run']) {
  const builder = { observeMail: vi.fn(() => ({ observations: [], skipped: {} })), observeEvents: vi.fn(() => ({ observations: [], skipped: {} })) };
  const deps: BackfillDeps = {
    db,
    clock: () => NOW,
    logger: silent,
    accounts: { run: run ?? (async (_alias, fn) => fn(google.apis)) },
    builder: builder as unknown as PeopleBuilder,
    store,
  };
  return { deps, builder };
}

describe('backfillStep', () => {
  it('reads the mail in steps of the budget, goes on from the saved page, then reads the events and is done', async () => {
    const google = fakeGoogle({ messages: 25, events: 150 });
    const store = fakeStore();
    const { deps, builder } = setup(google, store);

    const first = await backfillStep(deps, 'personal', 10);
    expect(first).toEqual({ account: 'personal', state: 'running', messages: 10, events: 0 });
    expect(google.calls.list[0]).toMatchObject({ q: `newer_than:${BACKFILL_DAYS}d -in:chats -in:spam -in:trash`, maxResults: 10 });
    expect(JSON.parse(store.state.backfillPage!)).toEqual({ phase: 'mail', pageToken: '10' });
    expect(store.state).toMatchObject({ backfill: 'running', backfillMessages: 10 });
    // the newest sent mail of the step is m0.
    expect(store.state.sentAfter).toBe(new Date(NOW.getTime() - 60_000).toISOString());

    const second = await backfillStep(deps, 'personal', 10);
    expect(second.messages).toBe(10);
    expect(google.calls.list[1]).toMatchObject({ pageToken: '10', maxResults: 10 });

    // the last 5 messages, then the events up to the budget of the step: one page of 100, and the next page.
    const third = await backfillStep(deps, 'personal', 10);
    expect(third).toEqual({ account: 'personal', state: 'running', messages: 5, events: 100 });
    expect(JSON.parse(store.state.backfillPage!)).toMatchObject({ phase: 'events', pageToken: '100' });

    const fourth = await backfillStep(deps, 'personal', 10);
    expect(fourth).toEqual({ account: 'personal', state: 'done', messages: 0, events: 50 });
    expect(store.state).toMatchObject({ backfill: 'done', backfillMessages: 25, backfillEvents: 150, backfilledAt: NOW.toISOString(), error: null });
    // the second page of events asks for the same range as the first.
    expect(google.calls.events[1]).toMatchObject({ timeMin: google.calls.events[0]!.timeMin, timeMax: google.calls.events[0]!.timeMax, pageToken: '100', singleEvents: true, calendarId: 'primary' });
    expect(google.calls.events[0]!.timeMin).toBe(new Date(NOW.getTime() - BACKFILL_DAYS * 86_400_000).toISOString());

    expect(google.calls.get).toHaveLength(25);
    expect(builder.observeMail).toHaveBeenCalledTimes(3);
    expect(builder.observeEvents).toHaveBeenCalledTimes(2);

    // a done account does nothing.
    const after = await backfillStep(deps, 'personal', 10);
    expect(after).toEqual({ account: 'personal', state: 'done', messages: 0, events: 0 });
    expect(google.calls.list).toHaveLength(3);
    expect(google.calls.events).toHaveLength(2);
  });

  it('stops the mail at BACKFILL_MAX_MESSAGES in all', async () => {
    const google = fakeGoogle({ messages: 30, events: 0 });
    const store = fakeStore({ backfill: 'running', backfillMessages: BACKFILL_MAX_MESSAGES - 4, backfillPage: JSON.stringify({ phase: 'mail', pageToken: '20' }) });
    const { deps } = setup(google, store);
    const result = await backfillStep(deps, 'personal', 10);
    expect(google.calls.list).toEqual([expect.objectContaining({ maxResults: 4, pageToken: '20' })]);
    expect(result).toEqual({ account: 'personal', state: 'done', messages: 4, events: 0 });
    expect(store.state.backfillMessages).toBe(BACKFILL_MAX_MESSAGES);
  });

  it('saves an auth error as failed, and the next step goes on from the saved page', async () => {
    const google = fakeGoogle({ messages: 25, events: 0 });
    const store = fakeStore({ backfill: 'running', backfillMessages: 10, backfillPage: JSON.stringify({ phase: 'mail', pageToken: '10' }) });
    let calls = 0;
    const { deps } = setup(google, store, async () => {
      calls++;
      throw new GoogleError('auth', 'google refused the sign-in');
    });
    const result = await backfillStep(deps, 'personal', 10);
    expect(result).toEqual({ account: 'personal', state: 'failed', messages: 0, events: 0, error: 'auth: google refused the sign-in' });
    expect(calls).toBe(1);
    expect(store.state).toMatchObject({ backfill: 'failed', error: 'auth: google refused the sign-in', backfillMessages: 10 });
    expect(JSON.parse(store.state.backfillPage!)).toEqual({ phase: 'mail', pageToken: '10' });

    const again = setup(google, store);
    const next = await backfillStep(again.deps, 'personal', 10);
    expect(next).toMatchObject({ state: 'running', messages: 10 });
    expect(google.calls.list[0]).toMatchObject({ pageToken: '10' });
    expect(store.state.error).toBeNull();
  });

  it('starts again from the beginning when the saved page is damaged', async () => {
    const google = fakeGoogle({ messages: 3, events: 0 });
    const store = fakeStore({ backfill: 'running', backfillPage: '{not json' });
    const { deps } = setup(google, store);
    expect(await backfillStep(deps, 'personal', 10)).toMatchObject({ state: 'done', messages: 3 });
    expect(google.calls.list[0]!.pageToken).toBeUndefined();
  });
});

describe('sweepSent', () => {
  const sentMail = (id: string, ms: number): gmail_v1.Schema$Message => ({ id, threadId: id, labelIds: ['SENT'], internalDate: String(ms), payload: { headers: [] } });

  it('does nothing before the backfill is done', async () => {
    const google = fakeGoogle({ messages: 0, events: 0, sent: [sentMail('s1', NOW.getTime())] });
    const store = fakeStore({ backfill: 'running' });
    const { deps, builder } = setup(google, store);
    expect(await sweepSent(deps, 'personal')).toBe(0);
    expect(google.calls.list).toHaveLength(0);
    expect(builder.observeMail).not.toHaveBeenCalled();
  });

  it('reads the sent mail after sentAfter, moves sentAfter, and skips the ids it read last time', async () => {
    const start = NOW.getTime() - 3_600_000;
    const google = fakeGoogle({ messages: 0, events: 0, sent: [sentMail('s2', NOW.getTime() - 1_500), sentMail('s1', NOW.getTime() - 60_000)] });
    const store = fakeStore({ backfill: 'done', backfilledAt: NOW.toISOString(), sentAfter: new Date(start).toISOString(), backfillPage: JSON.stringify({ phase: 'sent', seen: [] }) });
    const { deps, builder } = setup(google, store);

    expect(await sweepSent(deps, 'personal')).toBe(2);
    expect(google.calls.list[0]).toMatchObject({ q: `in:sent after:${Math.floor(start / 1000)}`, maxResults: 50 });
    expect(builder.observeMail).toHaveBeenCalledWith('personal', [expect.objectContaining({ id: 's2' }), expect.objectContaining({ id: 's1' })]);
    expect(store.state.sentAfter).toBe(new Date(NOW.getTime() - 1_500).toISOString());

    // the next sweep asks from the new time, and the same mail comes again without a second read.
    expect(await sweepSent(deps, 'personal')).toBe(0);
    expect(google.calls.list[1]).toMatchObject({ q: `in:sent after:${Math.floor((NOW.getTime() - 1_500) / 1000)}` });
    expect(google.calls.get).toEqual(['s2', 's1']);
    expect(builder.observeMail).toHaveBeenCalledTimes(1);
    expect(store.state.backfill).toBe('done');
  });

  it('starts at the end of the backfill when it read no sent mail, and never throws', async () => {
    const google = fakeGoogle({ messages: 0, events: 0 });
    const store = fakeStore({ backfill: 'done', backfilledAt: NOW.toISOString() });
    const { deps } = setup(google, store);
    expect(await sweepSent(deps, 'personal')).toBe(0);
    expect(google.calls.list[0]!.q).toBe(`in:sent after:${Math.floor(NOW.getTime() / 1000)}`);

    const failing = setup(google, store, async () => {
      throw new GoogleError('transient', 'timeout');
    });
    expect(await sweepSent(failing.deps, 'personal')).toBe(0);
    expect(store.state.backfill).toBe('done');
  });
});
