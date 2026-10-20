import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import type { GoogleApis } from '../google/accounts.js';
import { createLogger } from '../observability/logger.js';
import { backfillStep, SENT_SWEEP_MAX, sweepSent, type BackfillDeps } from './backfill.js';
import { createPeopleBuilder } from './builder.js';
import { backfillStateOf, saveBackfillState, searchPeople } from './store.js';

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
