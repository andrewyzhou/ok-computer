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

// round 4: a sender writes part of the heartbeat input. a mail whose text makes every heartbeat run fail (here the
// model refuses it) stayed open, so each retry failed again, and after five failures the scheduler turned the
// heartbeat off. now the text is held back after two failed runs, and the third run finishes.
it('a signal that makes the heartbeat fail does not turn the heartbeat off', async () => {
  let heartbeats = 0;
  const answer = async (call: ModelCall) => {
    const last = JSON.stringify(call.messages.at(-1));
    if (call.system.includes('You label items')) {
      const ids = [...last.matchAll(/item (\d+)/g)].map((match) => Number(match[1]));
      return fakeResponse({ toolCalls: [{ id: 'l1', name: 'label_signals', input: { labels: ids.map((id) => ({ id, label: 'needs_reply' })) } }] });
    }
    if (call.system.includes('This is a heartbeat run.')) {
      if (last.includes('tool_result')) return fakeResponse({ text: 'NO_REPLY' });
      heartbeats++;
      if (last.includes('POISON')) return fakeResponse({ stopReason: 'refusal', text: '' });
      return fakeResponse({ toolCalls: [{ id: 'h1', name: 'heartbeat_respond', input: { notify: false } }] });
    }
    return fakeResponse({ text: 'NO_REPLY' });
  };
  fake = await startFakeGoogle();
  fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
  fake.addAccount('school', 'school@example.com', refreshOf('school'));
  const t = createTestApp(
    Array.from({ length: 200 }, () => answer),
    {
      start: pdt('08:00'),
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
  await t.at(pdt('08:15'));
  fake.deliver('school', { id: 'm1', headers: { From: 'X <x@spam.example>', Subject: 'POISON', Date: 'Tue, 13 Oct 2026 08:20:00 -0700' }, snippet: 'text that the model refuses' });
  await t.at(pdt('08:30'));
  for (let minute = 45; minute <= 60 * 4; minute += 15) await t.at(new Date(Date.parse(pdt('08:00')) + minute * 60_000).toISOString());
  expect(t.rows("SELECT enabled FROM automations WHERE json_extract(payload, '$.type') = 'heartbeat'")).toEqual([{ enabled: 1 }]);
  expect(t.rows("SELECT handledAs, heartbeatFailures FROM integration_events WHERE externalId LIKE '%m1%'")).toEqual([{ handledAs: 'seen', heartbeatFailures: 2 }]);
  expect(t.printed()).not.toContain('turned it off');
  await t.app.stop();
}, 120_000);
