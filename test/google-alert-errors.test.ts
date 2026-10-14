import { afterEach, expect, it } from 'vitest';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { fakeResponse } from '../src/models/fake.js';
import { createTestApp } from './app-harness.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';
import { CLIENT_ID, CLIENT_SECRET, refreshOf } from './google-harness.js';

const pdt = (time: string) => new Date(`2026-10-13T${time}:00-07:00`).toISOString();
let fake: FakeGoogle;
afterEach(async () => fake?.close());

// verification round 2: the poll starts the sign-in alerts without await. a database error in their claim (for
// example SQLITE_BUSY after the busy timeout) was an unhandled rejection, and node ends the process on it.
it('logs a database error in the sign-in alerts instead of ending the process', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    fake = await startFakeGoogle();
    fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
    fake.addAccount('school', 'school@example.com', refreshOf('school'));
    const t = createTestApp(Array.from({ length: 40 }, () => async () => fakeResponse({ text: 'NO_REPLY' })), {
      start: pdt('08:00'),
      config: {
        slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['fake/m'] } },
        google: { clientId: CLIENT_ID, accounts: [{ alias: 'school', email: 'school@example.com' }] },
      },
      deps: {
        secrets: createMemorySecretStore({ 'google.client': CLIENT_SECRET, 'google.school': refreshOf('school') }),
        googleEndpoints: { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke`, authUrl: `${fake.url}auth` },
      },
    });
    t.db.prepare("UPDATE google_accounts SET status = 'ok', email = 'school@example.com', authorizedAt = '2026-10-01T00:00:00Z' WHERE alias = 'school'").run();
    await t.app.start();
    await t.at(pdt('08:15'));
    // the account was parked, and its message is not sent yet. the claim of the message meets a disk error.
    t.db.prepare("UPDATE google_accounts SET status = 'needs_auth', lastError = 'invalid_grant' WHERE alias = 'school'").run();
    t.db.exec("CREATE TRIGGER io BEFORE UPDATE OF alertedAt ON google_accounts BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    await t.at(pdt('08:30'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(unhandled).toEqual([]);
    expect(t.rows("SELECT status FROM runs WHERE trigger = 'poll' ORDER BY startedAt DESC LIMIT 1")).toEqual([{ status: 'completed' }]);
    await t.app.stop();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
