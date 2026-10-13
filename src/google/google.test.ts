import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
import { createFakeClient } from '../models/fake.js';
import { createSlotRunner } from '../models/slots.js';
import { createGoogle } from './google.js';

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
    for (let i = 0; i < 14; i++) expect(await google.poll()).toMatchObject({ status: 'completed', error: expect.stringContaining('personal gmail: 503') });
    expect(told).toEqual([expect.stringContaining('The gmail poll of the personal Google account has failed 12 times in a row')]);
    await google.close();
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
});
