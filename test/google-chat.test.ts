import { expect, it } from 'vitest';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { createTestApp } from './app-harness.js';
import { CLIENT_ID } from './google-harness.js';

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
