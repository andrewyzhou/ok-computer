import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ID, createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
import { createFakeClient } from '../models/fake.js';
import { createSlotRunner } from '../models/slots.js';
import { openDb } from '../db/index.js';
import { scheduleContext } from '../scheduler/context.js';
import { createAutomation } from '../scheduler/store.js';
import { signalDigest } from '../signals/digest.js';
import { googleConfigSchema } from './config.js';
import { createGoogle, syncGooglePoll } from './google.js';

let h: GoogleHarness;
afterEach(async () => h?.close());

describe('google poll job', () => {
  // a failed job backs off and is turned off after five failures. a google outage must not turn the poll off, and
  // the owner must hear about a long one.
  it('completes during an outage, and tells the owner once after twelve failed polls', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const told: string[] = [];
    const slots = createSlotRunner({ db: h.db, config: { slots: { utility: { chain: ['fake/m'], maxTokens: 100 } }, pricing: {} } as never, clients: { fake: createFakeClient([]) }, logger: h.logger });
    const google = createGoogle({
      db: h.db,
      clock: () => h.now.value,
      logger: h.logger,
      blobs: h.blobs,
      secrets: h.secrets,
      slots,
      config: h.config,
      timeZone: 'America/Los_Angeles',
      notifyOwner: (text) => void told.push(text),
      endpoints: { apiRoot: h.fake.url, tokenUrl: `${h.fake.url}token` },
    });
    h.fake.fault({ route: 'GET /gmail/v1/users/me/profile', status: 503, times: 14 });
    for (let i = 0; i < 14; i++) expect(await google.poll()).toMatchObject({ status: 'completed', error: expect.stringContaining('personal: 503') });
    expect(told).toEqual([expect.stringContaining('The Google poll of the personal account has failed 12 times in a row')]);
    await google.close();
  });

  it('is a run of its own, and its note says that a gap in the mail history made no signals', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const google = createGoogle({
      db: h.db,
      clock: () => h.now.value,
      logger: h.logger,
      blobs: h.blobs,
      secrets: h.secrets,
      slots: { call: async () => ({ ok: false, error: 'x', aborted: false }) },
      config: h.config,
      timeZone: 'UTC',
      notifyOwner: () => {},
      endpoints: { apiRoot: h.fake.url, tokenUrl: `${h.fake.url}token` },
      newId: () => `poll-${h.fake.requests.length}`,
    });
    const first = await google.poll();
    expect(first).toEqual({ status: 'completed', runId: expect.stringMatching(/^poll-/) });
    expect(h.rows('SELECT sessionKey, trigger, status, error FROM runs')).toEqual([{ sessionKey: 'poll:google', trigger: 'poll', status: 'completed', error: null }]);
    // every request of the poll links to its run.
    expect(h.rows('SELECT DISTINCT runId FROM google_requests')).toEqual([{ runId: first.runId }]);

    h.fake.mailbox('personal').oldestHistoryId = 5000;
    const gap = await google.poll();
    expect(gap.error).toContain('the gmail history of personal was too old, so only its inbox mail of the last 2 days made signals');
    expect(h.rows('SELECT error FROM runs WHERE id = ?', gap.runId!)).toEqual([{ error: gap.error }]);
    await google.close();
  });

  // the context of each run lists the next three automations. a poll every 15 minutes would fill it.
  it('stays out of the schedule in the context of a run', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-13T16:00:00Z');
    syncGooglePoll(db, { timeZone: 'UTC', google: googleConfigSchema.parse({ clientId: CLIENT_ID, accounts: [{ alias: 'personal' }] }) }, now);
    createAutomation(db, { name: 'water the plants', schedule: { kind: 'at', at: '2026-10-13T20:00:00Z' }, payload: { type: 'system_event', text: 'water' }, slot: 'main', createdBy: 'owner' }, now, 'UTC');
    const context = scheduleContext(db, now, 'UTC');
    expect(context).toContain('water the plants');
    expect(context).not.toContain('google poll');
  });

  it('skips in the chat process', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    const google = createGoogle({
      db: h.db,
      clock: () => h.now.value,
      logger: h.logger,
      blobs: h.blobs,
      secrets: h.secrets,
      slots: { call: async () => ({ ok: false, error: 'x', aborted: false }) },
      config: h.config,
      timeZone: 'UTC',
      notifyOwner: () => {},
      polls: false,
    });
    expect(await google.poll()).toEqual({ status: 'skipped', error: 'the google poll runs only in the background app' });
  });

  // the scheduler runs due jobs at the same time. a heartbeat that took the mail before the detectors ran would close
  // it without the hit, and the owner would never hear about the deadline.
  it('keeps a mail from a heartbeat while the poll that will check it waits for the calendar', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    const google = createGoogle({
      db: h.db,
      clock: () => h.now.value,
      logger: h.logger,
      blobs: h.blobs,
      secrets: h.secrets,
      slots: { call: async () => ({ ok: false, error: 'x', aborted: false }) },
      config: h.config,
      timeZone: 'America/Los_Angeles',
      notifyOwner: () => {},
      endpoints: { apiRoot: h.fake.url, tokenUrl: `${h.fake.url}token` },
    });
    await google.poll();
    h.fake.deliver('personal', { id: 'm1', labelIds: ['INBOX'], headers: { From: 't@school.example', Subject: 'Essay due Oct 20' }, snippet: 'submit the essay by Oct 20' });
    h.fake.fault({ route: 'GET /calendar/v3/calendars/primary/events', delayMs: 300, times: 2 });
    const polling = google.poll();
    while (!h.rows("SELECT 1 FROM integration_events WHERE externalId = 'm1' AND state = 'ready'").length) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signalDigest(h.db, h.now.value, 'America/Los_Angeles')).toBeUndefined();
    await polling;
    expect(signalDigest(h.db, h.now.value, 'America/Los_Angeles')?.text).toContain('detector date_not_on_calendar');
    await google.close();
  });

  // the date detector checks each mail one time. a mail that it checked against no calendar would keep a false hit.
  it('checks the mail against the calendar also when the read of another message failed', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.fake.upsertEvent('personal', { id: 'essay', summary: 'Essay due', start: { dateTime: '2026-10-20T17:00:00Z' }, end: { dateTime: '2026-10-20T18:00:00Z' }, organizer: { email: 'personal@example.com', self: true } });
    const google = createGoogle({
      db: h.db,
      clock: () => h.now.value,
      logger: h.logger,
      blobs: h.blobs,
      secrets: h.secrets,
      slots: { call: async () => ({ ok: false, error: 'x', aborted: false }) },
      config: h.config,
      timeZone: 'America/Los_Angeles',
      notifyOwner: () => {},
      endpoints: { apiRoot: h.fake.url, tokenUrl: `${h.fake.url}token` },
    });
    await google.poll();
    h.fake.deliver('personal', { id: 'm1', labelIds: ['INBOX'], headers: { From: 't@school.example', Subject: 'Essay due Oct 20' }, snippet: 'hand in the essay by Oct 20' });
    h.fake.deliver('personal', { id: 'm2', labelIds: ['INBOX'], headers: { From: 'a@b.example', Subject: 'hello' } });
    h.fake.fault({ route: 'GET /gmail/v1/users/me/messages/m2', status: 503, times: 1 });
    expect((await google.poll()).error).toContain('personal: 503');
    expect(h.rows("SELECT detectors FROM integration_events WHERE externalId = 'm1'")).toEqual([{ detectors: '[]' }]);
    await google.close();
  });
});
