import { createDashboard } from '../src/dashboard/server.js';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { fakeResponse } from '../src/models/fake.js';
import type { ModelCall } from '../src/models/types.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { startFakeGoogle } from './fake-google.js';
import { CLIENT_ID, CLIENT_SECRET, refreshOf } from './google-harness.js';

const pdt = (time: string) => new Date(`2026-10-13T${time}:00-07:00`).toISOString();

// the real app against the fake google: two accounts, a poll that finds a deadline that is not on the calendar and a
// newsletter, a heartbeat that tells the owner, a chat that searches mail, and an account whose sign-in google revoked.
export async function seedGoogle() {
  const fake = await startFakeGoogle();
  fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
  for (const alias of ['personal', 'school']) fake.addAccount(alias, `${alias}@example.com`, refreshOf(alias));
  const answer = async (call: ModelCall) => {
    const last = JSON.stringify(call.messages.at(-1));
    if (call.system.includes('You label items')) {
      const ids = [...last.matchAll(/item (\d+) \((\w+)\)/g)].map((match) => ({ id: Number(match[1]), label: match[2] === 'school' ? 'deadline' : 'newsletter' }));
      return fakeResponse({ toolCalls: [{ id: 'l1', name: 'label_signals', input: { labels: ids } }] });
    }
    if (last.includes('tool_result')) return fakeResponse({ text: last.includes('heartbeat_respond') ? 'NO_REPLY' : 'Found the essay mail.' });
    if (call.system.includes('This is a heartbeat run.')) {
      return fakeResponse({ toolCalls: [{ id: 'h1', name: 'heartbeat_respond', input: { notify: true, text: 'The essay is due Oct 20, and it is not on your calendar.' } }] });
    }
    return fakeResponse({ toolCalls: [{ id: 'g1', name: 'google__gmail_search', input: { account: 'school', query: 'essay' } }] });
  };
  const t = createTestApp(
    Array.from({ length: 40 }, () => answer),
    {
      start: pdt('09:00'),
      config: {
        slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['fake/m'] } },
        heartbeat: { every: '1h' },
        google: { clientId: CLIENT_ID, accounts: [{ alias: 'personal', email: 'personal@example.com' }, { alias: 'school', email: 'school@example.com' }] },
      },
      deps: {
        secrets: createMemorySecretStore({ 'google.client': CLIENT_SECRET, 'google.personal': refreshOf('personal'), 'google.school': refreshOf('school') }),
        googleEndpoints: { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke` },
      },
    },
  );
  for (const alias of ['personal', 'school']) {
    t.db.prepare("UPDATE google_accounts SET status = 'ok', email = ?, authorizedAt = '2026-10-01T00:00:00Z' WHERE alias = ?").run(`${alias}@example.com`, alias);
  }
  await t.app.start();
  await t.at(pdt('09:15'));
  fake.deliver('school', { id: 'essay', headers: { From: 'Prof. Lee <lee@school.example>', Subject: 'Essay due Oct 20', Date: 'Tue, 13 Oct 2026 09:20:00 -0700' }, snippet: 'please hand in the essay' });
  fake.deliver('personal', { id: 'deals', headers: { From: 'News <news@shop.example>', Subject: 'Weekly deals', Date: 'Tue, 13 Oct 2026 09:21:00 -0700' } });
  await t.at(pdt('09:30'));
  await t.at(pdt('10:00'));
  await t.say('find the essay mail');
  fake.revoke(refreshOf('personal'));
  await t.at(pdt('10:15'));
  const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app });
  return {
    t,
    fake,
    dashboard,
    async close() {
      await t.app.stop();
      await fake.close();
    },
  };
}
