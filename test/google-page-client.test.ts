import { describe, expect, it } from 'vitest';
import type { GooglePage } from '../src/dashboard/google-types.js';
import { createDashboard } from '../src/dashboard/server.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { CLIENT_ID, CLIENT_SECRET } from './google-harness.js';

// the client id comes from okc.config.json, but a connect also needs the secret from the client file. the page must
// say that the file is missing, and not only show the client id as if the setup were done.
describe('the google page before the client file', () => {
  it('says that the client secret is not stored and asks for the file first', async () => {
    const secrets = createMemorySecretStore({});
    const t = createTestApp([], {
      start: '2026-10-13T09:00:00-07:00',
      config: { google: { clientId: CLIENT_ID, accounts: [{ alias: 'personal', email: 'personal@example.com' }] } },
      deps: { secrets },
    });
    const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app });
    const before = (await (await dashboard.request('/api/google')).json()) as GooglePage;
    expect(before.clientId).toBe(CLIENT_ID);
    expect(before.clientStored).toBe(false);
    expect(before.accounts[0]!.nextStep).toBe('Upload the client file, then connect personal.');
    await secrets.set('google.client', CLIENT_SECRET);
    const after = (await (await dashboard.request('/api/google')).json()) as GooglePage;
    expect(after.clientStored).toBe(true);
    expect(after.accounts[0]!.nextStep).toBe('Connect personal, and pick its address at google.');
  });
});
