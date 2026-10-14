import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { createTestApp } from './app-harness.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';
import { CLIENT_ID, CLIENT_SECRET, refreshOf } from './google-harness.js';

let fake: FakeGoogle;
afterEach(async () => fake?.close());

// npm run chat runs the scheduler on the same database and does not poll. when its timer fired first, it claimed the
// poll and recorded it as skipped, and the background app did not poll in that slot.
it('leaves the google poll to the background app when npm run chat ticks first', async () => {
  fake = await startFakeGoogle();
  fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
  fake.addAccount('personal', 'personal@example.com', refreshOf('personal'));
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'okc-chat-')), 'okc.sqlite'));
  const make = (chat: boolean) =>
    createTestApp([], {
      start: '2026-10-13T16:00:00Z',
      config: { heartbeat: { every: '0' }, google: { clientId: CLIENT_ID, accounts: [{ alias: 'personal' }] } },
      deps: {
        db,
        secrets: createMemorySecretStore({ 'google.client': CLIENT_SECRET, 'google.personal': refreshOf('personal') }),
        googleEndpoints: { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke`, authUrl: `${fake.url}auth` },
        connectIntegrations: !chat,
      },
    });
  const service = make(false);
  const chat = make(true);
  db.prepare("UPDATE google_accounts SET status = 'ok', email = 'personal@example.com', authorizedAt = '2026-10-01T00:00:00Z', historyId = '1' WHERE alias = 'personal'").run();
  await service.app.start();
  await chat.app.start();

  await chat.at('2026-10-13T16:15:00Z');
  await service.at('2026-10-13T16:15:00Z');
  const runs = db.prepare("SELECT r.status FROM automation_runs r JOIN automations a ON a.id = r.automationId WHERE a.name = 'google poll'").all();
  expect(runs).toEqual([{ status: 'completed' }]);
  expect(fake.requests.filter((each) => each.path.startsWith('/gmail')).length).toBeGreaterThan(0);
  await chat.app.stop();
  await service.app.stop();
});

// /status listed only the mcp integrations, so the owner could not see on the phone whether a google sign-in works.
it('lists each google account and the state of its sign-in in /status', async () => {
  const t = createTestApp([], {
    start: '2026-10-13T16:00:00Z',
    config: { heartbeat: { every: '0' }, google: { clientId: CLIENT_ID, accounts: [{ alias: 'personal' }, { alias: 'school' }, { alias: 'work' }] } },
    deps: { secrets: createMemorySecretStore({}), connectIntegrations: false },
  });
  t.db.prepare("UPDATE google_accounts SET status = 'ok' WHERE alias = 'personal'").run();
  t.db.prepare("UPDATE google_accounts SET status = 'needs_auth' WHERE alias = 'school'").run();
  await t.app.start();
  await t.say('/status');
  expect(t.printed()).toContain('Integrations: google:personal ok, google:school needs auth, google:work signed out.');
  await t.app.stop();
});
