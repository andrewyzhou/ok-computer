import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import type { GoogleApis } from '../google/accounts.js';
import { createLogger } from '../observability/logger.js';
import { backfillStep, SENT_SWEEP_MAX, sweepSent, type BackfillDeps } from './backfill.js';
import { createPeopleBuilder } from './builder.js';
import { backfillStateOf, saveBackfillState, searchPeople } from './store.js';
import { setGmailPaceForTests } from '../inbox/gmail.js';

// the gmail reads keep to the pace of the inbox (src/inbox/gmail.ts). a test never waits for it.
beforeEach(() => setGmailPaceForTests({ sleep: async () => {} }));
afterEach(() => setGmailPaceForTests());

// the backfill and the sent sweep on the real store, with a fake gmail that lists the newest mail first, as gmail
// does. these cases look for mail that is read twice or never.

const NOW = new Date('2026-10-19T12:00:00Z');
const silent = createLogger({ consoleLevel: 'off' });

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function sent(i: number, ms: number): gmail_v1.Schema$Message {
  return {
    id: `s${i}`,
    threadId: `t${i}`,
    labelIds: ['SENT'],
    internalDate: String(ms),
    payload: {
      headers: [
        { name: 'From', value: 'Owner <owner@example.com>' },
        { name: 'To', value: `Person ${i} <p${i}@acme.com>` },
        { name: 'Subject', value: `hello ${i}` },
      ],
    },
  };
}

// a gmail whose sent folder holds the given mail. a query "in:sent after:<seconds>" gives the mail from that second
// on, so the newest mail of the last sweep comes again, newest first, a page of maxResults at a time.
function fakeGmail(mail: () => gmail_v1.Schema$Message[]) {
  const byId = () => new Map(mail().map((each) => [each.id!, each]));
  return {
    gmail: {
      users: {
        messages: {
          list: async (params: { q: string; maxResults: number; pageToken?: string }) => {
            const after = Number(/after:(\d+)/.exec(params.q)?.[1] ?? 0) * 1000;
            const source = mail()
              .filter((each) => Number(each.internalDate) >= after)
              .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
            const start = Number(params.pageToken ?? 0);
            const page = source.slice(start, start + params.maxResults);
            const end = start + page.length;
            return { data: { messages: page.map((each) => ({ id: each.id, threadId: each.threadId })), nextPageToken: end < source.length ? String(end) : undefined } };
          },
          get: async (params: { id: string }) => ({ data: byId().get(params.id)! }),
        },
      },
    },
    calendar: { events: { list: async () => ({ data: { items: [] } }) } },
  } as unknown as GoogleApis;
}

function setup(mail: () => gmail_v1.Schema$Message[]) {
  db = openDb(':memory:');
  db.prepare("INSERT INTO google_accounts (alias, email, updatedAt) VALUES ('personal', 'owner@example.com', 'x')").run();
  const d = db;
  const apis = fakeGmail(mail);
  const builder = createPeopleBuilder({ db: d, clock: () => NOW, logger: silent, timeZone: 'UTC' });
  const deps: BackfillDeps = { db: d, clock: () => NOW, logger: silent, accounts: { run: async (_alias, fn) => fn(apis) }, builder };
  return { db: d, deps };
}

describe('the sent sweep after a long pause', () => {
  it('reads each sent mail once over many polls with mail in the same second', async () => {
    const base = NOW.getTime() - 3_600_000;
    const mail: gmail_v1.Schema$Message[] = [];
    const { db, deps } = setup(() => mail);
    saveBackfillState(db, 'personal', { backfill: 'done', backfilledAt: new Date(base).toISOString(), sentAfter: new Date(base).toISOString() }, NOW);
    for (let i = 0; i < 5; i++) {
      mail.push(sent(i, base + 10_000 + i));
      await sweepSent(deps, 'personal');
    }
    const page = searchPeople(db, { limit: 50 }, NOW);
    expect(page.total).toBe(5);
    expect(page.people.every((each) => each.mailCount === 1)).toBe(true);
  });

  it('reads every sent mail when more than one sweep of mail was sent since the last poll', async () => {
    const base = NOW.getTime() - 7 * 86_400_000;
    const mail: gmail_v1.Schema$Message[] = [];
    const { db, deps } = setup(() => mail);
    saveBackfillState(db, 'personal', { backfill: 'done', backfilledAt: new Date(base).toISOString(), sentAfter: new Date(base).toISOString(), backfillPage: JSON.stringify({ phase: 'sent', seen: [] }) }, NOW);
    for (let i = 0; i < SENT_SWEEP_MAX + 10; i++) mail.push(sent(i, base + (i + 1) * 60_000));
    for (let poll = 0; poll < 5; poll++) await sweepSent(deps, 'personal');
    expect(searchPeople(db, { limit: 200 }, NOW).total).toBe(SENT_SWEEP_MAX + 10);
  });

  it('reads the mail that the owner sent while a backfill of many polls ran', async () => {
    const start = NOW.getTime() - 3_600_000;
    const mail = [sent(0, start - 60_000), sent(2, start - 120_000)];
    let now = new Date(start);
    const { db, deps } = setup(() => mail);
    const clocked = { ...deps, clock: () => now };
    // the first step reads one of the two older mails and stops at its budget.
    await backfillStep(clocked, 'personal', 1);
    mail.push(sent(1, start + 60_000));
    now = new Date(start + 120_000);
    await backfillStep(clocked, 'personal', 10);
    expect(backfillStateOf(db, 'personal', now).backfill).toBe('done');
    await sweepSent(clocked, 'personal');
    expect(searchPeople(db, { limit: 10 }, now).total).toBe(3);
  });
});

describe('the send-as addresses of the owner', () => {
  it('reads them once, and mail from an alias of the owner makes no person of the alias', async () => {
    const mail: gmail_v1.Schema$Message[] = [
      {
        id: 'a1',
        threadId: 'ta',
        labelIds: ['SENT'],
        internalDate: String(NOW.getTime() - 60_000),
        payload: { headers: [{ name: 'From', value: 'Owner <owner@work.example>' }, { name: 'To', value: 'Jane <jane@acme.com>' }] },
      },
    ];
    const { db, deps } = setup(() => mail);
    let reads = 0;
    const apis = fakeGmail(() => mail);
    (apis.gmail.users as unknown as { settings: unknown }).settings = {
      sendAs: {
        list: async () => {
          reads++;
          return { data: { sendAs: [{ sendAsEmail: 'owner@example.com' }, { sendAsEmail: 'Owner@Work.example' }] } };
        },
      },
    };
    const withAlias = { ...deps, accounts: { run: async <T>(_alias: string, fn: (apis: GoogleApis) => Promise<T>) => fn(apis) } };
    await backfillStep(withAlias, 'personal', 10);
    await backfillStep(withAlias, 'personal', 10);
    expect(reads).toBe(1);
    expect(backfillStateOf(db, 'personal', NOW).aliases).toEqual(['owner@example.com', 'owner@work.example']);
    const page = searchPeople(db, { limit: 10 }, NOW);
    expect(page.people.map((each) => each.primaryEmail)).toEqual(['jane@acme.com']);
  });
});

describe('the backfill on the real store', () => {
  it('makes the same people when a step is read twice after a crash before its save', async () => {
    const mail = Array.from({ length: 6 }, (_, i) => sent(i, NOW.getTime() - (i + 1) * 60_000));
    const { db, deps } = setup(() => mail);
    await backfillStep(deps, 'personal', 3);
    // a crash lost the saved position, so the next step reads the first page again.
    saveBackfillState(db, 'personal', { backfillPage: JSON.stringify({ phase: 'mail' }) }, NOW);
    await backfillStep(deps, 'personal', 100);
    const page = searchPeople(db, { limit: 50 }, NOW);
    expect(page.total).toBe(6);
    expect(page.people.every((each) => each.mailCount === 1)).toBe(true);
    expect(backfillStateOf(db, 'personal', NOW).backfill).toBe('done');
  });

  it('keeps an unknown phase in the saved position from stopping the backfill', async () => {
    const { db, deps } = setup(() => []);
    saveBackfillState(db, 'personal', { backfill: 'running', backfillPage: JSON.stringify({ phase: '__proto__' }) }, NOW);
    expect(await backfillStep(deps, 'personal', 10)).toMatchObject({ state: 'done' });
  });
});
