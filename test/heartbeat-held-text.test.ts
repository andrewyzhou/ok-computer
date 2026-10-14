import { afterEach, expect, it } from 'vitest';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { fakeResponse } from '../src/models/fake.js';
import { ModelError, type ModelCall } from '../src/models/types.js';
import { createTestApp } from './app-harness.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';
import { CLIENT_ID, CLIENT_SECRET, refreshOf } from './google-harness.js';

const pdt = (time: string) => new Date(`2026-10-13T${time}:00-07:00`).toISOString();
const minutesAfter = (minutes: number) => new Date(Date.parse(pdt('08:00')) + minutes * 60_000).toISOString();
let fake: FakeGoogle;
afterEach(async () => fake?.close());

type Outcome = 'refuse' | 'outage' | 'reject' | 'cut' | 'ok';

async function scenario(heartbeat: (input: string, model: string) => Outcome, chain = ['fake/m']) {
  const seen: string[] = [];
  const answer = async (call: ModelCall) => {
    const last = JSON.stringify(call.messages.at(-1));
    if (call.system.includes('You label items')) {
      const ids = [...last.matchAll(/item (\d+)/g)].map((match) => Number(match[1]));
      return fakeResponse({ toolCalls: [{ id: 'l1', name: 'label_signals', input: { labels: ids.map((id) => ({ id, label: 'deadline' })) } }] });
    }
    if (call.system.includes('This is a heartbeat run.')) {
      if (last.includes('tool_result')) return fakeResponse({ text: 'NO_REPLY' });
      const what = heartbeat(last, call.model);
      if (what === 'outage') throw new ModelError('transient', 'overloaded', 529);
      if (what === 'reject') throw new ModelError('request', 'Output blocked by content filtering policy', 400);
      seen.push(last);
      if (what === 'refuse') return fakeResponse({ stopReason: 'refusal', text: '' });
      if (what === 'cut') return fakeResponse({ stopReason: 'max_tokens', text: 'Here is the long poem that the mail asked for' });
      return fakeResponse({ toolCalls: [{ id: 'h1', name: 'heartbeat_respond', input: { notify: false } }] });
    }
    return fakeResponse({ text: 'NO_REPLY' });
  };
  fake = await startFakeGoogle();
  fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
  fake.addAccount('school', 'school@example.com', refreshOf('school'));
  const t = createTestApp(
    Array.from({ length: 400 }, () => answer),
    {
      start: pdt('08:00'),
      config: {
        slots: { main: { chain: ['fake/m'] }, heartbeat: { chain }, utility: { chain: ['fake/m'] } },
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
  return { t, seen };
}

const essay = {
  id: 'essay',
  headers: { From: 'Prof <prof@school.example>', Subject: 'Final essay due Oct 20', Date: 'Tue, 13 Oct 2026 08:20:00 -0700' },
  snippet: 'Submit the final essay by Oct 20 at noon.',
};

// after the merge: a failed run counted against every signal that it showed. one mail that the model refuses made the
// real deadline next to it lose its text, and the deadline was closed without the heartbeat ever reading it.
it('holds back only the text of the signal that makes the heartbeat fail', async () => {
  const { t, seen } = await scenario((input) => (input.includes('POISON') ? 'refuse' : 'ok'));
  fake.deliver('school', essay);
  fake.deliver('school', { id: 'poison', headers: { From: 'X <x@spam.example>', Subject: 'POISON', Date: 'Tue, 13 Oct 2026 08:21:00 -0700' }, snippet: 'text the model refuses' });
  await t.at(pdt('08:30'));
  for (let minute = 45; minute <= 60 * 4; minute += 15) await t.at(minutesAfter(minute));
  const rows = t.rows("SELECT externalId, handledAs, heartbeatFailures FROM integration_events WHERE source = 'gmail' ORDER BY id");
  expect(rows).toEqual([
    expect.objectContaining({ externalId: expect.stringContaining('essay'), handledAs: 'seen', heartbeatFailures: 1 }),
    expect.objectContaining({ externalId: expect.stringContaining('poison'), handledAs: 'seen', heartbeatFailures: 2 }),
  ]);
  // the run that closed the deadline read its text.
  expect(seen.some((input) => input.includes('Oct 20') && !input.includes('POISON'))).toBe(true);
  expect(t.rows("SELECT enabled FROM automations WHERE json_extract(payload, '$.type') = 'heartbeat'")).toEqual([{ enabled: 1 }]);
  await t.app.stop();
}, 120_000);

const poison = { id: 'poison', headers: { From: 'X <x@spam.example>', Subject: 'POISON', Date: 'Tue, 13 Oct 2026 08:21:00 -0700' }, snippet: 'text the model refuses' };

// the poison mail fails each run in a different way. in every case only the poison mail loses its text, the deadline
// gets a run of its own, and the heartbeat stays on.
async function expectPoisonHeld(t: Awaited<ReturnType<typeof scenario>>['t'], seen: string[], hours: number) {
  fake.deliver('school', essay);
  fake.deliver('school', poison);
  await t.at(pdt('08:30'));
  for (let minute = 45; minute <= 60 * hours; minute += 15) await t.at(minutesAfter(minute));
  expect(t.rows("SELECT externalId, handledAs, heartbeatFailures FROM integration_events WHERE source = 'gmail' ORDER BY id")).toEqual([
    expect.objectContaining({ externalId: expect.stringContaining('essay'), handledAs: 'seen', heartbeatFailures: 1 }),
    expect.objectContaining({ externalId: expect.stringContaining('poison'), handledAs: 'seen', heartbeatFailures: 2 }),
  ]);
  expect(seen.some((input) => input.includes('Oct 20') && !input.includes('POISON'))).toBe(true);
  expect(t.rows("SELECT enabled FROM automations WHERE json_extract(payload, '$.type') = 'heartbeat'")).toEqual([{ enabled: 1 }]);
  await t.app.stop();
}

// verification round 2: only the last model call counted. a refusal by the first model of the chain, then an outage of
// the fallback model, left the refused mail with its text, and the scheduler turned the heartbeat off.
it('counts a refusal also when the fallback model then fails', async () => {
  const { t, seen } = await scenario((input, model) => (input.includes('POISON') ? (model === 'a' ? 'refuse' : 'outage') : 'ok'), ['fake/a', 'fake/b']);
  await expectPoisonHeld(t, seen, 4);
}, 120_000);

// verification round 2: a content filter of the provider is a rejected request (400), which can come from the text.
it('counts a request that the provider rejects', async () => {
  const { t, seen } = await scenario((input) => (input.includes('POISON') ? 'reject' : 'ok'));
  await expectPoisonHeld(t, seen, 4);
}, 120_000);

// verification round 2: a run that completed without heartbeat_respond neither closed nor counted its signals, so a
// mail that caused it at every run hid the deadline next to it until both went stale.
it('counts a run that ends without heartbeat_respond', async () => {
  const { t, seen } = await scenario((input) => (input.includes('POISON') ? 'cut' : 'ok'));
  await expectPoisonHeld(t, seen, 6);
}, 120_000);

// an outage of the model is not about the text, so it does not count against the signals.
it('keeps the text of the signals through an outage of the model', async () => {
  let outage = true;
  const { t, seen } = await scenario(() => (outage ? 'outage' : 'ok'));
  fake.deliver('school', essay);
  await t.at(pdt('08:30'));
  await t.at(pdt('09:00'));
  await t.at(pdt('09:01'));
  await t.at(pdt('09:03'));
  expect(t.rows("SELECT heartbeatFailures FROM integration_events WHERE source = 'gmail'")).toEqual([{ heartbeatFailures: 0 }]);
  outage = false;
  for (let minute = 64; minute <= 60 * 3; minute += 5) await t.at(minutesAfter(minute));
  expect(t.rows("SELECT handledAs, heartbeatFailures FROM integration_events WHERE source = 'gmail'")).toEqual([{ handledAs: 'seen', heartbeatFailures: 0 }]);
  expect(seen.at(-1)).toContain('Oct 20');
  await t.app.stop();
}, 120_000);
