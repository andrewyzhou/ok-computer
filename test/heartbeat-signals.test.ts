import { afterEach, expect, it } from 'vitest';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { fakeResponse } from '../src/models/fake.js';
import type { ModelCall } from '../src/models/types.js';
import { createTestApp } from './app-harness.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';
import { CLIENT_ID, CLIENT_SECRET, refreshOf } from './google-harness.js';

const pdt = (time: string) => new Date(`2026-10-13T${time}:00-07:00`).toISOString();
let fake: FakeGoogle;
afterEach(async () => fake?.close());

// a small heartbeat model can answer in text only. that run did not decide about the signals, so the next heartbeat
// shows them again and can tell the owner.
it('keeps the signals open after a heartbeat run that gave no heartbeat_respond', async () => {
  let heartbeats = 0;
  const answer = async (call: ModelCall) => {
    const last = JSON.stringify(call.messages.at(-1));
    if (call.system.includes('You label items')) {
      const ids = [...last.matchAll(/item (\d+)/g)].map((match) => Number(match[1]));
      return fakeResponse({ toolCalls: [{ id: 'l1', name: 'label_signals', input: { labels: ids.map((id) => ({ id, label: 'deadline' })) } }] });
    }
    if (call.system.includes('This is a heartbeat run.')) {
      if (last.includes('tool_result')) return fakeResponse({ text: 'NO_REPLY' });
      heartbeats++;
      if (heartbeats === 1) return fakeResponse({ text: 'The essay deadline is not on the calendar.' });
      const notify = last.includes('date_not_on_calendar');
      return fakeResponse({ toolCalls: [{ id: 'h1', name: 'heartbeat_respond', input: notify ? { notify: true, text: 'ESSAY DUE' } : { notify: false } }] });
    }
    return fakeResponse({ text: 'NO_REPLY' });
  };
  fake = await startFakeGoogle();
  fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
  fake.addAccount('school', 'school@example.com', refreshOf('school'));
  const t = createTestApp(
    Array.from({ length: 40 }, () => answer),
    {
      start: pdt('09:00'),
      config: {
        slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['fake/m'] } },
        heartbeat: { every: '1h' },
        google: { clientId: CLIENT_ID, accounts: [{ alias: 'school', email: 'school@example.com' }] },
      },
      deps: {
        secrets: createMemorySecretStore({ 'google.client': CLIENT_SECRET, 'google.school': refreshOf('school') }),
        googleEndpoints: { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke`, authUrl: `${fake.url}auth` },
      },
    },
  );
  t.db.prepare("UPDATE google_accounts SET status = 'ok', email = 'school@example.com', authorizedAt = '2026-10-01T00:00:00Z' WHERE alias = 'school'").run();
  await t.app.start();
  await t.at(pdt('09:15'));
  fake.deliver('school', { id: 'm1', headers: { From: 'Teacher <t@school.example>', Subject: 'Essay due Oct 20', Date: 'Tue, 13 Oct 2026 09:20:00 -0700' }, snippet: 'please submit the essay by Oct 20' });
  await t.at(pdt('09:30'));
  expect(t.rows("SELECT detectors FROM integration_events WHERE externalId = 'm1'")).toEqual([{ detectors: expect.stringContaining('date_not_on_calendar') }]);

  await t.at(pdt('10:00'));
  expect(heartbeats).toBe(1);
  expect(t.rows("SELECT handledAs FROM integration_events WHERE externalId = 'm1'")).toEqual([{ handledAs: null }]);

  await t.at(pdt('11:00'));
  expect(heartbeats).toBe(2);
  expect(t.rows("SELECT handledAs FROM integration_events WHERE externalId = 'm1'")).toEqual([{ handledAs: 'notified' }]);
  expect(t.printed()).toContain('ESSAY DUE');
  await t.app.stop();
});
