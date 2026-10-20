import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
import type { BackfillDeps, BackfillResult } from '../people/backfill.js';
import type { BuildResult, PeopleBuilder } from '../people/builder.js';
import { createGoogle, type GoogleDeps } from './google.js';
import { createSync } from './sync.js';

// the backfill and the sent sweep are replaced, so these tests see each call and its google requests. the fakes read
// through accounts.run, as the real ones do, so their requests land in the trace of the poll.
const backfill = vi.hoisted(() => ({
  calls: [] as string[],
  step: undefined as undefined | ((deps: BackfillDeps, account: string) => Promise<BackfillResult>),
  sweep: undefined as undefined | ((deps: BackfillDeps, account: string) => Promise<number>),
}));
vi.mock('../people/backfill.js', async (original) => ({
  ...(await original<typeof import('../people/backfill.js')>()),
  backfillStep: async (deps: BackfillDeps, account: string) => {
    backfill.calls.push(`backfill ${account}`);
    return backfill.step!(deps, account);
  },
  sweepSent: async (deps: BackfillDeps, account: string) => {
    backfill.calls.push(`sweep ${account}`);
    return backfill.sweep!(deps, account);
  },
}));

let h: GoogleHarness;
let other: GoogleHarness | undefined;
afterEach(async () => {
  await h?.close();
  await other?.close();
  other = undefined;
});
beforeEach(() => {
  backfill.calls = [];
  backfill.step = async (deps, account) => {
    await deps.accounts.run(account, (apis) => apis.gmail.users.labels.list({ userId: 'me' }));
    return { account, state: 'running', messages: 0, events: 0 };
  };
  backfill.sweep = async (deps, account) => {
    await deps.accounts.run(account, (apis) => apis.gmail.users.drafts.list({ userId: 'me' }));
    return 0;
  };
});

const empty: BuildResult = { observations: [], skipped: {} };

// a builder that records what the poll gives it. throws makes each call fail, as a broken builder would.
function recordingBuilder(options: { throws?: boolean } = {}) {
  const mail: Array<{ account: string; messages: gmail_v1.Schema$Message[] }> = [];
  const events: Array<{ account: string; events: calendar_v3.Schema$Event[] }> = [];
  const builder: PeopleBuilder = {
    observeMail(account, messages) {
      mail.push({ account, messages: [...messages] });
      if (options.throws) throw new Error('builder broke on secret.person@corp.example');
      return empty;
    },
    observeEvents(account, list) {
      events.push({ account, events: [...list] });
      if (options.throws) throw new Error('builder broke on secret.person@corp.example');
      return empty;
    },
  };
  return { builder, mail, events };
}

const syncWith = (builder?: PeopleBuilder) =>
  createSync({ db: h.db, clock: () => h.now.value, logger: h.logger, blobs: h.blobs, accounts: h.accounts, timeZone: 'America/Los_Angeles', ...(builder ? { people: builder } : {}) });

const mail = (id: string, extra: { labelIds?: string[] } = {}) => ({
  id,
  labelIds: extra.labelIds ?? ['INBOX', 'UNREAD'],
  headers: {
    From: 'Teacher <t@school.example>',
    To: 'personal@example.com, Pat <pat@corp.example>',
    Cc: 'Sam <sam@corp.example>',
    Subject: `subject ${id}`,
    Date: 'Tue, 13 Oct 2026 08:00:00 -0700',
    'List-Id': '<class.school.example>',
  },
  snippet: `about ${id}`,
});

const header = (message: gmail_v1.Schema$Message, name: string) => message.payload?.headers?.find((each) => each.name === name)?.value;
const signals = () => h.rows("SELECT externalId, state, summary, payloadBlob FROM integration_events WHERE source = 'gmail' ORDER BY id");
const cursors = (alias: string) => h.rows('SELECT historyId, calendarSyncToken FROM google_accounts WHERE alias = ?', alias)[0]!;
const event = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  summary: `meeting ${id}`,
  start: { dateTime: '2026-10-14T17:00:00Z' },
  end: { dateTime: '2026-10-14T18:00:00Z' },
  organizer: { email: 'boss@corp.example' },
  attendees: [{ email: 'personal@example.com', self: true, responseStatus: 'accepted' }, { email: 'boss@corp.example' }],
  ...extra,
});

describe('people hooks in the sync', () => {
  it('gives a new inbox mail to the builder once with its recipients, and keeps the signal as it was', async () => {
    // the same mail through a sync without people gives the row and the blob to compare with.
    const run = async (builder?: PeopleBuilder) => {
      h = await createGoogleHarness({ accounts: ['personal'] });
      h.signedIn('personal');
      const sync = syncWith(builder);
      await sync.pollAll('poll-run');
      h.fake.deliver('personal', mail('m1'));
      await sync.pollAll('poll-run');
      await sync.pollAll('poll-run');
      const [row] = signals();
      const blob = JSON.parse(h.blobs.read(String(row!.payloadBlob))!) as Record<string, unknown>;
      return { row: { ...row, payloadBlob: undefined }, blob, request: h.fake.requests.find((each) => each.path.startsWith('/gmail/v1/users/me/messages/m1'))!.path };
    };
    const before = await run();
    other = h;
    const recorded = recordingBuilder();
    const after = await run(recorded.builder);

    expect(recorded.mail).toHaveLength(1);
    const [given] = recorded.mail;
    expect(given!.account).toBe('personal');
    expect(given!.messages.map((each) => each.id)).toEqual(['m1']);
    expect(header(given!.messages[0]!, 'To')).toBe('personal@example.com, Pat <pat@corp.example>');
    expect(header(given!.messages[0]!, 'Cc')).toBe('Sam <sam@corp.example>');
    // the poll asks gmail for the headers of the people memory.
    for (const name of ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'To', 'Cc', 'List-Id', 'Precedence', 'Auto-Submitted']) {
      expect(after.request).toContain(`metadataHeaders=${encodeURIComponent(name)}`);
    }
    expect(after.row).toEqual(before.row);
    expect(after.row).toMatchObject({ state: 'ready', summary: 'from Teacher <t@school.example>: "subject m1" about m1' });
    expect(Object.keys(after.blob)).toEqual(['from', 'subject', 'date', 'snippet', 'threadId', 'listUnsubscribe', 'listUnsubscribePost']);
    expect(after.blob).toEqual(before.blob);
  });

  it('gives no spam, trash or archived mail to the builder', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const recorded = recordingBuilder();
    const sync = syncWith(recorded.builder);
    await sync.pollAll('poll-run');
    h.fake.deliver('personal', mail('spam', { labelIds: ['INBOX', 'SPAM'] }));
    h.fake.deliver('personal', mail('trash', { labelIds: ['INBOX', 'TRASH'] }));
    h.fake.deliver('personal', mail('archived'));
    // the fetch of the archived mail fails once, and the owner archives it before the next poll.
    h.fake.fault({ route: 'GET /gmail/v1/users/me/messages/archived', status: 500, times: 1 });
    await sync.pollAll('poll-run');
    h.fake.mailbox('personal').messages.get('archived')!.labelIds = ['UNREAD'];
    await sync.pollAll('poll-run');
    expect(signals().map((each) => [each.externalId, each.state])).toEqual([
      ['spam', 'skipped'],
      ['trash', 'skipped'],
      ['archived', 'skipped'],
    ]);
    expect(recorded.mail).toEqual([]);
  });

  it('gives each page of the live range and each change of the calendar to the builder, a cancelled one too', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const recorded = recordingBuilder();
    const sync = syncWith(recorded.builder);
    for (let i = 0; i < 299; i++) h.fake.upsertEvent('personal', event(`e${i}`));
    // a declined event is not on the calendar of the detectors, but the builder gets it and decides.
    h.fake.upsertEvent('personal', event('declined', { attendees: [{ email: 'personal@example.com', self: true, responseStatus: 'declined' }, { email: 'boss@corp.example' }] }));
    await sync.pollAll('poll-run');
    // the first read of the changes and the live range each give two pages.
    expect(recorded.events.map((each) => each.events.length)).toEqual([250, 50, 250, 50]);
    expect(recorded.events.flatMap((each) => each.events).filter((each) => each.id === 'declined')).toHaveLength(2);

    recorded.events.length = 0;
    await sync.pollAll('poll-run');
    // nothing changed: the change list is empty, and the live range is read again.
    expect(recorded.events.map((each) => each.events.length)).toEqual([0, 250, 50]);

    recorded.events.length = 0;
    // google lists a cancelled event in the changes without its attendees.
    h.fake.upsertEvent('personal', { id: 'e1', status: 'cancelled', start: { dateTime: '2026-10-14T17:00:00Z' }, end: { dateTime: '2026-10-14T18:00:00Z' } });
    await sync.pollAll('poll-run');
    const [changes, ...range] = recorded.events;
    expect(changes!.events).toEqual([expect.objectContaining({ id: 'e1', status: 'cancelled' })]);
    expect(range.flatMap((each) => each.events).some((each) => each.id === 'e1')).toBe(false);
    expect(recorded.events.every((each) => each.account === 'personal')).toBe(true);
  });

  it('polls as before when the builder throws: the cursors move, and the log has no address', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const recorded = recordingBuilder({ throws: true });
    const sync = syncWith(recorded.builder);
    h.fake.upsertEvent('personal', event('e1'));
    await sync.pollAll('poll-run');
    const first = cursors('personal');
    expect(first.calendarSyncToken).toBe('st-2');
    h.fake.deliver('personal', mail('m1'));
    h.fake.upsertEvent('personal', event('e2'));
    const [report] = await sync.pollAll('poll-run');
    expect(report).toMatchObject({ ok: true, failures: 0 });
    expect(report!.events!.map((each) => each.id)).toEqual(['e1', 'e2']);
    expect(cursors('personal')).toEqual({ historyId: '1001', calendarSyncToken: 'st-3' });
    expect(signals().map((each) => [each.externalId, each.state])).toEqual([['m1', 'ready']]);
    expect(h.rows("SELECT count(*) AS n FROM integration_events WHERE source = 'calendar'")).toEqual([{ n: 1 }]);
    expect(recorded.mail).toHaveLength(1);
    const logs = readdirSync(join(h.dir, 'logs'))
      .map((name) => readFileSync(join(h.dir, 'logs', name), 'utf8'))
      .join('');
    expect(logs).toContain('the people builder failed');
    expect(logs).not.toContain('secret.person');
    expect(logs).not.toContain('builder broke');
  });
});

describe('people backfill in the poll job', () => {
  const googleOf = (people: GoogleDeps['people'], extra: Partial<GoogleDeps> = {}) =>
    createGoogle({
      db: h.db,
      clock: () => h.now.value,
      logger: h.logger,
      blobs: h.blobs,
      secrets: h.secrets,
      slots: { call: async () => ({ ok: false, error: 'x', aborted: false }) },
      config: h.config,
      timeZone: 'UTC',
      notifyOwner: async () => true,
      endpoints: { apiRoot: h.fake.url, tokenUrl: `${h.fake.url}token` },
      ...(people ? { people } : {}),
      ...extra,
    });

  it('runs one backfill step and one sweep for each healthy account, in the trace of the poll', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school', 'work'] });
    h.signedIn('personal');
    h.signedIn('school');
    // work is not signed in, so it is unavailable. the history of school fails.
    h.db.prepare("UPDATE google_accounts SET historyId = '777' WHERE alias = 'school'").run();
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', contains: 'startHistoryId=777', status: 503 });
    const recorded = recordingBuilder();
    const google = googleOf({ builder: recorded.builder });
    const result = await google.poll();
    expect(result).toMatchObject({ status: 'completed', error: expect.stringContaining('school: ') });
    expect(result.error).not.toContain('people backfill');
    expect(backfill.calls).toEqual(['backfill personal', 'sweep personal']);
    // the requests of the backfill and the sweep belong to the poll run.
    const extra = h.rows("SELECT account, runId FROM google_requests WHERE url LIKE '%/labels%' OR url LIKE '%/drafts%' ORDER BY id");
    expect(extra).toEqual([
      { account: 'personal', runId: result.runId },
      { account: 'personal', runId: result.runId },
    ]);
    expect(h.rows('SELECT DISTINCT runId FROM google_requests')).toEqual([{ runId: result.runId }]);
    await google.close();
  });

  it('runs the accounts side by side, and the backfill before the sweep in each', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school'] });
    h.signedIn('personal');
    h.signedIn('school');
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    backfill.step = async (_deps, account) => {
      order.push(`start ${account}`);
      // the first account waits until the second one has started, which only parallel steps allow.
      if (account === 'personal') await held;
      else release();
      order.push(`end ${account}`);
      return { account, state: 'running', messages: 0, events: 0 };
    };
    backfill.sweep = async (_deps, account) => (order.push(`sweep ${account}`), 0);
    const google = googleOf({ builder: recordingBuilder().builder });
    expect(await google.poll()).toEqual({ status: 'completed', runId: expect.any(String) });
    expect(order.indexOf('start school')).toBeLessThan(order.indexOf('end personal'));
    for (const account of ['personal', 'school']) expect(order.indexOf(`end ${account}`)).toBeLessThan(order.indexOf(`sweep ${account}`));
    await google.close();
  });

  it('notes a failed backfill step on the run and still completes it', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school'] });
    h.signedIn('personal');
    h.signedIn('school');
    backfill.step = async (_deps, account) => {
      if (account === 'school') throw new Error('backfill exploded');
      return { account, state: 'failed', messages: 0, events: 0, error: 'google said no' };
    };
    // a failed sweep is only logged. it tries again at the next poll.
    backfill.sweep = async () => {
      throw new Error('sweep exploded');
    };
    const told: string[] = [];
    const google = googleOf({ builder: recordingBuilder().builder }, { notifyOwner: async (text) => (told.push(text), true) });
    const result = await google.poll();
    expect(result).toEqual({ status: 'completed', runId: expect.any(String), error: 'people backfill of personal failed; people backfill of school failed' });
    expect(h.rows('SELECT status, error FROM runs WHERE id = ?', result.runId!)).toEqual([{ status: 'completed', error: result.error }]);
    expect(backfill.calls.filter((each) => each.startsWith('sweep'))).toHaveLength(2);
    expect(told).toEqual([]);
    await google.close();
  });

  it('runs nothing of the people memory when the process does not poll, or when the backfill is off', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const recorded = recordingBuilder();
    const quiet = googleOf({ builder: recorded.builder }, { polls: false });
    expect(await quiet.poll()).toMatchObject({ status: 'skipped' });
    await quiet.close();
    expect(h.fake.requests).toEqual([]);
    expect(recorded.mail).toEqual([]);
    expect(recorded.events).toEqual([]);

    const off = googleOf({ builder: recorded.builder, backfill: false });
    expect(await off.poll()).toEqual({ status: 'completed', runId: expect.any(String) });
    expect(backfill.calls).toEqual([]);
    expect(h.fake.requests.some((each) => each.path.includes('/labels') || each.path.includes('/drafts'))).toBe(false);
    await off.close();
    expect(backfill.calls).toEqual([]);
  });
});
