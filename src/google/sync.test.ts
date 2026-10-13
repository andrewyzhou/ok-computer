import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, refreshOf, type GoogleHarness } from '../../test/google-harness.js';
import { createSync } from './sync.js';

let h: GoogleHarness;
afterEach(async () => h?.close());

const mail = (id: string, subject: string, extra: { labelIds?: string[]; from?: string } = {}) => ({
  id,
  labelIds: extra.labelIds ?? ['INBOX', 'UNREAD'],
  headers: { From: extra.from ?? 'Teacher <t@school.example>', Subject: subject, Date: 'Tue, 13 Oct 2026 08:00:00 -0700' },
  snippet: `about ${subject}`,
});
const signals = (alias?: string) =>
  h.rows(`SELECT externalId, kind, state, summary FROM integration_events ${alias ? 'WHERE account = ?' : ''} ORDER BY id`, ...(alias ? [alias] : []));
const cursor = (alias: string, api = 'gmail') => h.rows('SELECT cursor FROM google_sync WHERE alias = ? AND api = ?', alias, api)[0]?.cursor;
const hits = (route: string) => h.fake.requests.filter((each) => `${each.method} ${each.path}`.startsWith(route)).length;

describe('gmail sync', () => {
  it('takes the first history id as a baseline, then turns new inbox mail into signals', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.fake.deliver('personal', mail('old', 'old mail'));
    await h.sync.pollAll();
    expect(signals()).toEqual([]);
    expect(cursor('personal')).toBe('1001');

    h.fake.deliver('personal', mail('m1', 'Essay due Friday'));
    h.fake.deliver('personal', mail('m2', 'a sent copy', { labelIds: ['SENT'] }));
    const [report] = await h.sync.pollAll();
    expect(report).toMatchObject({ api: 'gmail', ok: true, added: 1 });
    expect(signals()).toEqual([
      { externalId: 'm1', kind: 'mail', state: 'ready', summary: 'from Teacher <t@school.example>: "Essay due Friday" about Essay due Friday' },
    ]);
    expect(cursor('personal')).toBe('1003');
  });

  // the sdk retries a get three times on a 5xx by default. that hides the failure and quadruples the load.
  it('sends one request for one failure, and keeps the cursor where it was', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await h.sync.pollAll();
    h.fake.deliver('personal', mail('m1', 'one'));
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', status: 503, times: 1 });
    const before = hits('GET /gmail/v1/users/me/history');
    const [report] = await h.sync.pollAll();
    expect(hits('GET /gmail/v1/users/me/history') - before).toBe(1);
    expect(report).toMatchObject({ ok: false, error: expect.stringContaining('503') });
    expect(cursor('personal')).toBe('1000');
    expect(h.rows("SELECT failures FROM google_sync WHERE alias = ? AND api = 'gmail'", 'personal')).toEqual([{ failures: 1 }]);
    await h.sync.pollAll();
    expect(signals().map((each) => each.externalId)).toEqual(['m1']);
    expect(h.rows('SELECT failures, lastError FROM google_sync WHERE api = ?', 'gmail')).toEqual([{ failures: 0, lastError: null }]);
  });

  it('loses and repeats nothing when a later history page fails', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await h.sync.pollAll();
    for (let i = 0; i < 700; i++) h.fake.deliver('personal', mail(`m${i}`, `mail ${i}`));
    // the first page answers and the second one resets the connection. no row and no cursor move may stay.
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', contains: 'pageToken=', reset: true, times: 1 });
    const first = await h.sync.pollAll();
    expect(first[0]).toMatchObject({ ok: false });
    expect(signals()).toHaveLength(0);
    expect(cursor('personal')).toBe('1000');
    await h.sync.pollAll();
    const ids = signals().map((each) => each.externalId);
    expect(ids).toHaveLength(700);
    expect(new Set(ids).size).toBe(700);
    expect(cursor('personal')).toBe('1700');
  });

  it('resyncs from a fresh history id after google forgets the old one, without a duplicate', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await h.sync.pollAll();
    h.fake.deliver('personal', mail('m1', 'seen before'));
    await h.sync.pollAll();
    h.fake.deliver('personal', mail('m2', 'new while away'));
    h.fake.mailbox('personal').oldestHistoryId = 5000;
    const [report] = await h.sync.pollAll();
    expect(report).toMatchObject({ ok: true, resync: true, added: 1 });
    expect(signals().map((each) => each.externalId)).toEqual(['m1', 'm2']);
    expect(cursor('personal')).toBe('1002');
  });

  it('marks mail that was deleted before its fetch, and fetches the rest at the next poll after a failure', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await h.sync.pollAll();
    for (const id of ['a', 'b', 'c']) h.fake.deliver('personal', mail(id, id));
    h.fake.mailbox('personal').messages.delete('a');
    h.fake.fault({ route: 'GET /gmail/v1/users/me/messages/c', status: 500, times: 1 });
    await h.sync.pollAll();
    expect(signals().map((each) => [each.externalId, each.state])).toEqual([['a', 'gone'], ['b', 'ready'], ['c', 'new']]);
    await h.sync.pollAll();
    expect(signals().map((each) => [each.externalId, each.state])).toEqual([['a', 'gone'], ['b', 'ready'], ['c', 'ready']]);
  });

  it('joins a running poll instead of a second one', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const [a, b] = await Promise.all([h.sync.pollAll(), h.sync.pollAll()]);
    expect(a).toBe(b);
    expect(hits('GET /gmail/v1/users/me/profile')).toBe(1);
  });

  // a second process (or a second copy of the service) can poll the same account at the same moment.
  it('keeps one copy of each signal when two pollers race on one database', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await h.sync.pollAll();
    for (let i = 0; i < 20; i++) h.fake.deliver('personal', mail(`m${i}`, `mail ${i}`));
    const other = createSync({ db: h.db, clock: () => h.now.value, logger: h.logger, blobs: h.blobs, accounts: h.accounts });
    const reports = (await Promise.all([h.sync.pollAll(), other.pollAll()])).flat();
    expect(reports.filter((each) => each.api === 'gmail')).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(signals()).toHaveLength(20);
    expect(signals().every((each) => each.state === 'ready')).toBe(true);
    expect(cursor('personal')).toBe('1020');
  });
});

describe('token health', () => {
  it('parks a revoked account, tells the owner once, and keeps polling the other accounts', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school'] });
    h.signedIn('personal');
    h.signedIn('school');
    await h.sync.pollAll();
    h.fake.revoke(refreshOf('school'));
    // the cached access token of school still works at the fake until the revoke, which ended it too.
    h.fake.deliver('personal', mail('p1', 'for personal'));
    const reports = await h.sync.pollAll();
    expect(reports.find((each) => each.alias === 'personal' && each.api === 'gmail')).toMatchObject({ ok: true, added: 1 });
    expect(reports.find((each) => each.alias === 'school')).toMatchObject({ ok: false, error: expect.stringContaining('sign-in refused') });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.text).toContain('Google stopped accepting the sign-in of the school account');
    expect(h.rows('SELECT status FROM google_accounts WHERE alias = ?', 'school')).toEqual([{ status: 'needs_auth' }]);

    // a parked account makes no request at all, so a dead token is never tried in a loop.
    const before = h.fake.requests.length;
    await h.sync.pollAll();
    await h.sync.pollAll();
    expect(h.fake.requests.slice(before).some((each) => each.body.includes(refreshOf('school')))).toBe(false);

    // a restart does not repeat the message.
    h.restart();
    await h.sync.pollAll();
    expect(h.alerts).toHaveLength(1);
  });

  it('names testing mode when the sign-in died after about seven days', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal', '2026-10-06T15:00:00Z');
    h.fake.revoke(refreshOf('personal'));
    await h.sync.pollAll();
    expect(h.alerts[0]!.text).toContain('Testing mode');
  });

  it('gets a new access token after a 401 and goes on', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await h.sync.pollAll();
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', status: 401, times: 1, body: { error: { code: 401, message: 'Invalid Credentials' } } });
    const tokens = h.fake.requests.filter((each) => each.path === '/token').length;
    const [report] = await h.sync.pollAll();
    expect(report).toMatchObject({ ok: true });
    expect(h.fake.requests.filter((each) => each.path === '/token').length).toBe(tokens + 1);
    expect(h.alerts).toEqual([]);
  });
});

describe('calendar sync', () => {
  const event = (id: string, summary: string, start: string, organizer: { email: string; self?: boolean } = { email: 'boss@work.example' }) => ({
    id,
    summary,
    start: { dateTime: start },
    end: { dateTime: new Date(Date.parse(start) + 3600_000).toISOString() },
    organizer,
  });
  const calendarSignals = () => h.rows("SELECT externalId, kind FROM integration_events WHERE source = 'calendar' ORDER BY id");

  it('copies the calendar without signals, then signals only changes by other people', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.fake.upsertEvent('personal', event('e1', 'standing meeting', '2026-10-14T17:00:00Z'));
    await h.sync.pollAll();
    expect(h.rows('SELECT eventId, summary FROM calendar_events')).toEqual([{ eventId: 'e1', summary: 'standing meeting' }]);
    expect(calendarSignals()).toEqual([]);

    h.fake.upsertEvent('personal', event('e1', 'standing meeting moved', '2026-10-14T18:00:00Z'));
    h.fake.upsertEvent('personal', event('mine', 'gym', '2026-10-14T20:00:00Z', { email: 'personal@example.com', self: true }));
    await h.sync.pollAll();
    expect(calendarSignals()).toEqual([{ externalId: expect.stringMatching(/^e1@/), kind: 'event_change' }]);
    // a cancelled event in an incremental list has no organizer. the copy still knows that another person owns it.
    h.fake.upsertEvent('personal', { id: 'e1', status: 'cancelled', start: {}, end: {} });
    await h.sync.pollAll();
    expect(calendarSignals().map((each) => each.kind)).toEqual(['event_change', 'event_cancelled']);
    expect(h.rows('SELECT status, summary FROM calendar_events WHERE eventId = ?', 'e1')).toEqual([{ status: 'cancelled', summary: 'standing meeting moved' }]);
  });

  it('repeats no signal when a later page fails, and rebuilds the copy after a 410', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await h.sync.pollAll();
    for (let i = 0; i < 300; i++) h.fake.upsertEvent('personal', event(`e${i}`, `invite ${i}`, '2026-10-20T17:00:00Z'));
    // the second page fails once. the first page committed its rows, and the retry reads them again.
    h.fake.fault({ route: 'GET /calendar/v3/calendars/primary/events', contains: 'pageToken=', status: 503, times: 1 });
    const failed = await h.sync.pollAll();
    expect(failed.find((each) => each.api === 'calendar')).toMatchObject({ ok: false });
    expect(calendarSignals()).toHaveLength(250);
    await h.sync.pollAll();
    expect(calendarSignals()).toHaveLength(300);

    h.fake.mailbox('personal').oldestSyncVersion = 10_000;
    const [, calendar] = await h.sync.pollAll();
    expect(calendar).toMatchObject({ ok: true, resync: true, added: 0 });
    expect(h.rows('SELECT COUNT(*) AS n FROM calendar_events')).toEqual([{ n: 300 }]);
    expect(calendarSignals()).toHaveLength(300);
  });
});
