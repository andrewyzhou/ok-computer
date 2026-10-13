import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ID, CLIENT_SECRET, createGoogleHarness, refreshOf, type GoogleHarness } from '../../test/google-harness.js';
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
const cursor = (alias: string, column = 'historyId') => h.rows(`SELECT ${column} AS cursor FROM google_accounts WHERE alias = ?`, alias)[0]?.cursor;
const hits = (route: string) => h.fake.requests.filter((each) => `${each.method} ${each.path}`.startsWith(route)).length;
const poll = () => h.sync.pollAll('poll-run');

describe('gmail sync', () => {
  it('takes the first history id as a baseline, then turns new inbox mail into signals', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.fake.deliver('personal', mail('old', 'old mail'));
    await poll();
    expect(signals()).toEqual([]);
    expect(cursor('personal')).toBe('1001');

    h.fake.deliver('personal', mail('m1', 'Essay due Friday'));
    h.fake.deliver('personal', mail('m2', 'a sent copy', { labelIds: ['SENT'] }));
    const [report] = await poll();
    expect(report).toMatchObject({ alias: 'personal', ok: true, failures: 0 });
    expect(signals()).toEqual([
      { externalId: 'm1', kind: 'mail', state: 'ready', summary: 'from Teacher <t@school.example>: "Essay due Friday" about Essay due Friday' },
    ]);
    expect(h.rows('SELECT runId FROM integration_events')).toEqual([{ runId: 'poll-run' }]);
    expect(cursor('personal')).toBe('1003');
  });

  // the sdk retries a get three times on a 5xx by default. that hides the failure and quadruples the load.
  it('sends one request for one failure, and keeps the cursor where it was', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    h.fake.deliver('personal', mail('m1', 'one'));
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', status: 503, times: 1 });
    const before = hits('GET /gmail/v1/users/me/history');
    const [report] = await poll();
    expect(hits('GET /gmail/v1/users/me/history') - before).toBe(1);
    expect(report).toMatchObject({ ok: false, failures: 1, error: expect.stringContaining('503') });
    expect(cursor('personal')).toBe('1000');
    expect(h.rows('SELECT failures FROM google_accounts WHERE alias = ?', 'personal')).toEqual([{ failures: 1 }]);
    await poll();
    expect(signals().map((each) => each.externalId)).toEqual(['m1']);
    expect(h.rows('SELECT failures, lastError FROM google_accounts')).toEqual([{ failures: 0, lastError: null }]);
  });

  it('loses and repeats nothing when a later history page fails', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    for (let i = 0; i < 700; i++) h.fake.deliver('personal', mail(`m${i}`, `mail ${i}`));
    // the first page answers and the second one resets the connection. no row and no cursor move may stay.
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', contains: 'pageToken=', reset: true, times: 1 });
    const first = await poll();
    expect(first[0]).toMatchObject({ ok: false });
    expect(signals()).toHaveLength(0);
    expect(cursor('personal')).toBe('1000');
    await poll();
    const ids = signals().map((each) => each.externalId);
    expect(ids).toHaveLength(700);
    expect(new Set(ids).size).toBe(700);
    expect(cursor('personal')).toBe('1700');
  });

  it('resyncs from a fresh history id after google forgets the old one, without a duplicate', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    h.fake.deliver('personal', mail('m1', 'seen before'));
    await poll();
    h.fake.deliver('personal', mail('m2', 'new while away'));
    h.fake.mailbox('personal').oldestHistoryId = 5000;
    const [report] = await poll();
    expect(report).toMatchObject({ ok: true, resync: true });
    expect(signals().map((each) => each.externalId)).toEqual(['m1', 'm2']);
    expect(cursor('personal')).toBe('1002');
  });

  it('marks mail that was deleted before its fetch, and fetches the rest at the next poll after a failure', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    for (const id of ['a', 'b', 'c']) h.fake.deliver('personal', mail(id, id));
    h.fake.mailbox('personal').messages.delete('a');
    h.fake.fault({ route: 'GET /gmail/v1/users/me/messages/c', status: 500, times: 1 });
    await poll();
    expect(signals().map((each) => [each.externalId, each.state])).toEqual([['a', 'gone'], ['b', 'ready'], ['c', 'new']]);
    await poll();
    expect(signals().map((each) => [each.externalId, each.state])).toEqual([['a', 'gone'], ['b', 'ready'], ['c', 'ready']]);
  });

  it('joins a running poll instead of a second one', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const [a, b] = await Promise.all([poll(), poll()]);
    expect(a).toBe(b);
    expect(hits('GET /gmail/v1/users/me/profile')).toBe(1);
  });

  // a second process (or a second copy of the service) can poll the same account at the same moment.
  it('keeps one copy of each signal when two pollers race on one database', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    for (let i = 0; i < 20; i++) h.fake.deliver('personal', mail(`m${i}`, `mail ${i}`));
    const other = createSync({ db: h.db, clock: () => h.now.value, logger: h.logger, blobs: h.blobs, accounts: h.accounts, timeZone: 'UTC' });
    const reports = (await Promise.all([poll(), other.pollAll('other-run')])).flat();
    expect(reports).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(signals()).toHaveLength(20);
    expect(signals().every((each) => each.state === 'ready')).toBe(true);
    expect(cursor('personal')).toBe('1020');
  });
});

describe('gmail cursor', () => {
  // the unique key already stops a duplicate. the compare and set stops a slow poller from moving the cursor back,
  // which would read the same history again at each poll.
  it('never moves the cursor back when a slow poll ends after a newer one', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    const slow = createSync({ db: h.db, clock: () => h.now.value, logger: h.logger, blobs: h.blobs, accounts: h.accounts, timeZone: 'UTC' });
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', delayMs: 300, times: 1 });
    const late = slow.pollAll('slow-run');
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.fake.deliver('personal', mail('m1', 'one'));
    await poll();
    h.fake.deliver('personal', mail('m2', 'two'));
    await poll();
    expect(cursor('personal')).toBe('1002');
    await late;
    expect(cursor('personal')).toBe('1002');
  });

  it('follows the history id of a mailbox that changes without new mail', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    // labels and reads move the history id, and history.list gives no messagesAdded record for them.
    h.fake.mailbox('personal').historyId += 40;
    await poll();
    expect(cursor('personal')).toBe('1040');
  });
});

describe('token health', () => {
  it('parks a revoked account, tells the owner once, and keeps polling the other accounts', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school'] });
    h.signedIn('personal');
    h.signedIn('school');
    await poll();
    h.fake.revoke(refreshOf('school'));
    h.fake.deliver('personal', mail('p1', 'for personal'));
    const reports = await poll();
    expect(reports.find((each) => each.alias === 'personal')).toMatchObject({ ok: true });
    expect(signals('personal').map((each) => each.externalId)).toEqual(['p1']);
    expect(reports.find((each) => each.alias === 'school')).toMatchObject({ ok: false, error: expect.stringContaining('sign-in refused') });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.text).toContain('Google stopped accepting the sign-in of the school account');
    expect(h.rows('SELECT status FROM google_accounts WHERE alias = ?', 'school')).toEqual([{ status: 'needs_auth' }]);

    // a parked account makes no request at all, so a dead token is never tried in a loop.
    const before = h.fake.requests.length;
    await poll();
    await poll();
    expect(h.fake.requests.slice(before).some((each) => each.body.includes(refreshOf('school')))).toBe(false);

    // a restart does not repeat the message.
    h.restart();
    await poll();
    expect(h.alerts).toHaveLength(1);
  });

  it('tells the owner once when two calls find the dead token at the same time', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.fake.revoke(refreshOf('personal'));
    const call = () => h.accounts.run('personal', (apis) => apis.gmail.users.getProfile({ userId: 'me' })).catch((err: Error) => err);
    await Promise.all([call(), call(), call()]);
    expect(h.alerts).toHaveLength(1);
  });

  // a bug or a database error inside a call is not a google error. it must not park the account or change its name.
  it('passes an error that does not come from the sdk through unchanged', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await expect(
      h.accounts.run('personal', async () => {
        throw new TypeError('a bug');
      }),
    ).rejects.toThrow(TypeError);
    expect(h.accounts.unavailable('personal')).toBeUndefined();
  });

  it('names testing mode when the sign-in died after about seven days', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal', '2026-10-06T15:00:00Z');
    h.fake.revoke(refreshOf('personal'));
    await poll();
    expect(h.alerts[0]!.text).toContain('Testing mode');
  });

  it('gets a new access token after a 401 and goes on', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', status: 401, times: 1, body: { error: { code: 401, message: 'Invalid Credentials' } } });
    const tokens = h.fake.requests.filter((each) => each.path === '/token').length;
    const [report] = await poll();
    expect(report).toMatchObject({ ok: true });
    expect(h.fake.requests.filter((each) => each.path === '/token').length).toBe(tokens + 1);
    expect(h.alerts).toEqual([]);
  });
});

describe('token health against the token endpoint', () => {
  const tokenRequests = () => h.fake.requests.filter((each) => each.path === '/token').length;

  // a 401 alone proves nothing. the library gets a new token, and the token endpoint answers 503: an outage.
  it('keeps the account and its token when a 401 meets an outage of the token endpoint', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', status: 401, times: 1, body: { error: { code: 401, message: 'Invalid Credentials' } } });
    h.fake.fault({ route: 'POST /token', status: 503, times: 4 });
    const [report] = await poll();
    expect(report).toMatchObject({ ok: false, error: expect.stringContaining('the token request failed with 503') });
    expect(h.alerts).toEqual([]);
    expect(h.rows('SELECT status FROM google_accounts')).toEqual([{ status: 'ok' }]);
    expect(h.secrets.values.get('google.personal')).toBe(refreshOf('personal'));
    await poll();
    expect(h.rows('SELECT failures FROM google_accounts')).toEqual([{ failures: 0 }]);
  });

  it('sends one message for a dead sign-in, then makes no token request, and works again after a new sign-in', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    h.fake.revoke(refreshOf('personal'));
    await poll();
    expect(h.alerts).toHaveLength(1);
    const before = tokenRequests();
    await poll();
    await poll();
    expect(tokenRequests()).toBe(before);
    // the tokens stay in the credential manager. only the owner's connect replaces them.
    expect(h.secrets.values.get('google.personal')).toBe(refreshOf('personal'));
    // mail that comes while the account waits for the owner is news after the new sign-in.
    h.fake.deliver('personal', mail('during', 'while parked'));

    h.fake.nextSignIn = { alias: 'personal', refreshToken: '1//new-sign-in-after-revoke-0123456789' };
    const begun = await h.accounts.beginSignIn('personal');
    const url = new URL((begun as { url: string }).url);
    await fetch(`${url.searchParams.get('redirect_uri')}?code=good-code&state=${url.searchParams.get('state')}`).then((res) => res.text());
    h.fake.deliver('personal', mail('back', 'after the new sign-in'));
    const [report] = await poll();
    expect(report).toMatchObject({ ok: true });
    expect(signals().map((each) => each.externalId)).toEqual(['during', 'back']);
  });

  // a mistyped client secret must not look like eight dead sign-ins.
  it('parks every account with one message when google refuses the client, and a new client file lifts it', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school'] });
    h.signedIn('personal');
    h.signedIn('school');
    h.fake.fault({ route: 'POST /token', status: 401, body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } });
    await poll();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.text).toContain('Google refused the OAuth client of OK Computer');
    expect(h.rows('SELECT status FROM google_accounts ORDER BY alias')).toEqual([{ status: 'needs_auth' }, { status: 'needs_auth' }]);
    const before = tokenRequests();
    await poll();
    expect(tokenRequests()).toBe(before);

    h.fake.clearFaults();
    expect(await h.accounts.saveClient({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } })).toEqual({ saved: true });
    expect(h.rows('SELECT status, alertedAt FROM google_accounts ORDER BY alias')).toEqual([
      { status: 'ok', alertedAt: null },
      { status: 'ok', alertedAt: null },
    ]);
    expect((await poll()).every((each) => each.ok)).toBe(true);
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
  const calendarSignals = () => h.rows("SELECT externalId, kind, summary FROM integration_events WHERE source = 'calendar' ORDER BY id");
  const listCalls = () =>
    h.fake.requests
      .filter((each) => each.method === 'GET' && each.path.startsWith('/calendar/v3/calendars/primary/events?') && !each.path.includes('timeMax='))
      .map((each) => new URL(each.path, 'http://x').searchParams);

  it('reads one day back first, then follows the sync token, and signals only changes by other people', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.fake.upsertEvent('personal', event('past', 'last year', '2025-10-14T17:00:00Z'));
    h.fake.upsertEvent('personal', event('e1', 'standing meeting', '2026-10-14T17:00:00Z'));
    await poll();
    expect(calendarSignals()).toEqual([]);
    const [first] = listCalls();
    expect(first!.get('timeMin')).toBe('2026-10-12T16:00:00.000Z');
    expect(first!.get('singleEvents')).toBe('true');
    expect(first!.get('syncToken')).toBeNull();
    expect(cursor('personal', 'calendarSyncToken')).toMatch(/^st-/);

    h.fake.upsertEvent('personal', event('e1', 'standing meeting moved', '2026-10-14T18:00:00Z'));
    h.fake.upsertEvent('personal', event('mine', 'gym', '2026-10-14T20:00:00Z', { email: 'personal@example.com', self: true }));
    await poll();
    const later = listCalls().at(-1)!;
    expect(later.get('syncToken')).toMatch(/^st-/);
    expect(later.get('singleEvents')).toBe('true');
    expect(later.get('timeMin')).toBeNull();
    expect(calendarSignals()).toEqual([
      { externalId: expect.stringMatching(/^e1@/), kind: 'event_change', summary: 'boss@work.example: "standing meeting moved" at 2026-10-14T18:00:00.000Z' },
    ]);

    // without a copy of the calendar, a cancelled event without an organizer makes no signal.
    h.fake.upsertEvent('personal', { id: 'e1', status: 'cancelled', start: {}, end: {} });
    expect(await poll()).toEqual([expect.objectContaining({ ok: true })]);
    expect(calendarSignals()).toHaveLength(1);
  });

  it('marks an invitation that waits for an answer', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    h.fake.upsertEvent('personal', { ...event('i1', 'kickoff', '2026-10-15T17:00:00Z'), attendees: [{ email: 'personal@example.com', self: true, responseStatus: 'needsAction' }] });
    await poll();
    expect(calendarSignals().map((each) => each.kind)).toEqual(['invite']);
  });

  it('repeats no signal when a later page fails, and reads again without signals after a 410', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await poll();
    for (let i = 0; i < 300; i++) h.fake.upsertEvent('personal', event(`e${i}`, `invite ${i}`, '2026-10-20T17:00:00Z'));
    // the second page fails once. the first page committed its rows, and the retry reads them again.
    h.fake.fault({ route: 'GET /calendar/v3/calendars/primary/events', contains: 'pageToken=', status: 503, times: 1 });
    const [failed] = await poll();
    expect(failed).toMatchObject({ ok: false });
    expect(calendarSignals()).toHaveLength(250);
    await poll();
    expect(calendarSignals()).toHaveLength(300);

    h.fake.mailbox('personal').oldestSyncVersion = 10_000;
    const [again] = await poll();
    expect(again).toMatchObject({ ok: true });
    expect(calendarSignals()).toHaveLength(300);
    expect(cursor('personal', 'calendarSyncToken')).toMatch(/^st-/);
  });

  it('reads the live range of the calendar for the detectors, without declined and cancelled events', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.fake.upsertEvent('personal', event('soon', 'Standup', '2026-10-13T17:30:00Z'));
    h.fake.upsertEvent('personal', { id: 'day', summary: 'Essay deadline', start: { date: '2026-10-22' }, end: { date: '2026-10-23' }, organizer: { self: true } });
    h.fake.upsertEvent('personal', { ...event('no', 'declined', '2026-10-14T17:00:00Z'), attendees: [{ email: 'personal@example.com', self: true, responseStatus: 'declined' }] });
    h.fake.upsertEvent('personal', event('far', 'next year', '2027-10-14T17:00:00Z'));
    const [report] = await poll();
    expect(report!.events).toEqual([
      { account: 'personal', id: 'soon', summary: 'Standup', start: '2026-10-13T17:30:00.000Z', allDay: false },
      { account: 'personal', id: 'day', summary: 'Essay deadline', start: '2026-10-22', allDay: true },
    ]);
  });
});
