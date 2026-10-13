import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { fakeResponse } from '../src/models/fake.js';
import type { ModelCall, ToolCall } from '../src/models/types.js';
import { createLogger } from '../src/observability/logger.js';
import { sessionTaint } from '../src/policy/store.js';
import { createTestApp } from './app-harness.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';
import { CLIENT_ID, CLIENT_SECRET, refreshOf } from './google-harness.js';

const pdt = (time: string, day = '2026-10-13') => new Date(`${day}T${time}:00-07:00`).toISOString();

let fake: FakeGoogle;
afterEach(async () => fake?.close());

// what the owner asks for in the chat, and the tool call that the fake model makes for it.
const ASKS: Array<[string, ToolCall]> = [
  ['unsubscribe me from the shop', { id: 'u1', name: 'google__gmail_unsubscribe', input: { account: 'personal', messageId: 'n1', sender: 'news@shop.example', target: 'https://shop.example/u/abc' } }],
  ['unsubscribe me from the other shop', { id: 'u2', name: 'google__gmail_unsubscribe', input: { account: 'personal', messageId: 's1', sender: 'news@shop.example', target: 'https://evil.example/u' } }],
  ['write to ana', { id: 's1', name: 'google__gmail_send', input: { account: 'personal', to: ['ana@example.com'], subject: 'Hi', body: 'See you soon.' } }],
  [
    'invite ana',
    { id: 'c1', name: 'google__calendar_create_event', input: { account: 'school', summary: 'Study group', start: '2026-10-15T16:00:00-07:00', end: '2026-10-15T17:00:00-07:00', attendees: ['ana@example.com'] } },
  ],
];

// the fake model answers by the kind of request, because the poll and the heartbeat can run in either order.
async function answer(call: ModelCall) {
  const last = JSON.stringify(call.messages.at(-1));
  if (call.system.includes('You label items')) {
    const ids = [...last.matchAll(/item (\d+)/g)].map((match) => Number(match[1]));
    return fakeResponse({ toolCalls: [{ id: 'l1', name: 'label_signals', input: { labels: ids.map((id) => ({ id, label: 'deadline' })) } }] });
  }
  if (last.includes('tool_result')) return fakeResponse({ text: 'NO_REPLY' });
  if (call.system.includes('This is a heartbeat run.')) {
    const notify = last.includes('date_not_on_calendar');
    return fakeResponse({ toolCalls: [{ id: 'h1', name: 'heartbeat_respond', input: notify ? { notify: true, text: 'Your essay is due Oct 20, and it is not on your calendar.' } : { notify: false } }] });
  }
  const ask = [...ASKS].reverse().find(([text]) => last.includes(text));
  return fakeResponse(ask ? { toolCalls: [ask[1]] } : { text: 'NO_REPLY' });
}

function filesUnder(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out = statSync(path).isDirectory() ? [...out, ...filesUnder(path)] : [...out, path];
  }
  return out;
}

const newsletter = (id: string, from: string, target: string) => ({
  id,
  headers: {
    From: from,
    Subject: 'Deals',
    'List-Unsubscribe': `<${target}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Authentication-Results': 'mx.google.com; dkim=pass',
  },
});

describe('google acceptance', () => {
  it('polls into signals, tells the owner about a deadline missing from the calendar, holds unsubscribe, send and invites for approval, and keeps every secret out of logs, rows and blobs', async () => {
    fake = await startFakeGoogle();
    fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead, SCOPES.send];
    fake.code = `4/auth-code-${randomBytes(12).toString('hex')}`;
    for (const alias of ['personal', 'school']) fake.addAccount(alias, `${alias}@example.com`, refreshOf(alias));
    fake.upsertEvent('personal', { id: 'd1', summary: 'Dentist', start: { dateTime: '2026-10-20T16:00:00Z' }, end: { dateTime: '2026-10-20T17:00:00Z' }, organizer: { self: true } });
    const secrets = createMemorySecretStore({ 'google.client': CLIENT_SECRET, 'google.personal': refreshOf('personal') });
    // the logger writes files, so the test can read every line that the run wrote.
    const logDir = mkdtempSync(join(tmpdir(), 'okc-google-logs-'));
    const t = createTestApp(
      Array.from({ length: 40 }, () => answer),
      {
        start: pdt('09:00'),
        config: {
          slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['fake/m'] } },
          heartbeat: { every: '1h' },
          google: { clientId: CLIENT_ID, send: true, accounts: [{ alias: 'personal', email: 'personal@example.com' }, { alias: 'school' }] },
        },
        deps: {
          secrets,
          googleEndpoints: { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke`, authUrl: `${fake.url}auth` },
          logger: createLogger({ dir: logDir, consoleLevel: 'off' }),
        },
      },
    );
    t.db.prepare("UPDATE google_accounts SET status = 'ok', email = 'personal@example.com', authorizedAt = '2026-10-01T00:00:00Z' WHERE alias = 'personal'").run();
    // school signs in through the real flow, so the authorization code passes through the app.
    fake.nextSignIn = { alias: 'school', refreshToken: refreshOf('school') };
    const begun = (await t.app.google!.accounts.beginSignIn('school')) as { url: string };
    const link = new URL(begun.url);
    expect(await (await fetch(`${link.searchParams.get('redirect_uri')}?code=${encodeURIComponent(fake.code)}&state=${link.searchParams.get('state')}`)).text()).toContain('Signed in as school@example.com');
    // the first token requests fail, and the server quotes the request body with the refresh token and the client
    // secret in it. the auth library retries a token post three times, so the fault outlasts the retries.
    fake.fault({ route: 'POST /token', status: 500, times: 8, echoAuth: true });
    await t.app.start();

    // the first poll fails at the token endpoint. the mail after the sign-in is news.
    await t.at(pdt('09:15'));
    expect(t.rows("SELECT COUNT(*) AS n FROM google_accounts WHERE lastError LIKE '%injected fault%'")).toEqual([{ n: 2 }]);
    await t.at(pdt('09:30'));
    fake.deliver('school', { id: 'm1', headers: { From: 'Teacher <t@school.example>', Subject: 'Essay due Oct 20', Date: 'Tue, 13 Oct 2026 09:20:00 -0700' }, snippet: 'please submit the essay by Oct 20' });
    fake.deliver('personal', newsletter('n1', 'News <news@shop.example>', 'https://shop.example/u/abc'));
    // the display name carries the address of the shop. the real sender is someone else.
    fake.deliver('personal', newsletter('s1', '"news@shop.example" <evil@y.example>', 'https://evil.example/u'));
    // a server error that echoes the authorization header. its text reaches the log and the account row.
    fake.fault({ route: 'GET /calendar/v3/calendars/primary/events', status: 500, times: 1, echoAuth: true });
    fake.fault({ route: 'GET /gmail/v1/users/me/history', status: 503, times: 1, echoAuth: true });
    await t.at(pdt('09:45'));
    await t.at(pdt('10:00'));
    await t.at(pdt('10:15'));

    // the detectors ran before the classifier, and the label links to its model call in the poll run.
    const [essay] = t.rows("SELECT label, detectors, labelModelCallId, runId FROM integration_events WHERE externalId = 'm1'");
    expect(essay).toMatchObject({ label: 'deadline', detectors: expect.stringContaining('date_not_on_calendar') });
    expect(t.rows('SELECT runId, slot FROM model_calls WHERE id = ?', Number(essay!.labelModelCallId))).toEqual([{ runId: essay!.runId, slot: 'utility' }]);
    expect(t.rows('SELECT trigger, status FROM runs WHERE id = ?', String(essay!.runId))).toEqual([{ trigger: 'poll', status: 'completed' }]);

    // the heartbeat runs each hour with an empty checklist. the one at 10:00 can run before or after the poll of 10:00.
    await t.at(pdt('11:00'));
    await t.at(pdt('12:00'));
    expect(t.printed()).toContain('okc> Your essay is due Oct 20, and it is not on your calendar.');
    const [deadline] = t.rows("SELECT handledAs, handledBy FROM integration_events WHERE externalId = 'm1'");
    expect(deadline!.handledAs).toBe('notified');
    const key = `heartbeat:${String(deadline!.handledBy)}`;
    expect(sessionTaint(t.db, key).map((each) => each.source)).toEqual(expect.arrayContaining(['gmail:school']));
    expect(JSON.stringify(t.model.calls.find((call) => JSON.stringify(call.messages).includes('date_not_on_calendar'))?.messages)).toMatch(/<untrusted source=[^>]*gmail:school/);
    // the owner hears about the deadline exactly once.
    expect(t.printed().split('Your essay is due Oct 20').length - 1).toBe(1);

    // an unsubscribe, a send and an invitation each wait for the owner. nothing left the pc for them.
    const before = fake.requests.length;
    for (const [text] of ASKS) await t.say(text);
    expect(t.rows('SELECT id, toolName, status FROM approvals ORDER BY id')).toEqual([
      { id: 1, toolName: 'google__gmail_unsubscribe', status: 'pending' },
      { id: 2, toolName: 'google__gmail_unsubscribe', status: 'pending' },
      { id: 3, toolName: 'google__gmail_send', status: 'pending' },
      { id: 4, toolName: 'google__calendar_create_event', status: 'pending' },
    ]);
    expect(fake.requests.slice(before)).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(t.printed()).toContain('https://shop.example/u/abc');
    expect(t.rows("SELECT riskLevel, account FROM tool_calls WHERE name = 'google__calendar_create_event'")).toEqual([{ riskLevel: 'external', account: 'school' }]);

    // the owner approves the unsubscribe from the false shop. the tool reads the message again and refuses, and the
    // refusal does not give the approval back to the owner.
    await t.app.resolveApproval(2, 'approve', 'dashboard');
    await t.at(pdt('12:05'));
    expect(t.rows('SELECT status FROM approvals WHERE id = 2')).toEqual([{ status: 'approved' }]);
    const [refused] = t.rows("SELECT output FROM tool_calls WHERE toolCallId = 'approval-2'");
    expect(String(refused!.output)).toContain('the message is from evil@y.example, not from \\"news@shop.example\\"');
    expect(fake.requests.slice(before).map((each) => each.path)).toEqual(['/gmail/v1/users/me/messages/s1?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=Authentication-Results']);

    await t.app.stop();

    // every token, the authorization code and the client secret stay out of the logs, the blobs and the database.
    const issued = new Set(fake.requests.map((each) => each.authorization?.replace(/^Bearer /, '')).filter((each): each is string => !!each));
    expect(issued.size).toBeGreaterThan(0);
    // the raw form and the percent-encoded form of a form body or a query string.
    const secretsToFind = [...issued, refreshOf('personal'), refreshOf('school'), CLIENT_SECRET, fake.code].flatMap((each) => [each, encodeURIComponent(each)]);
    const texts: Array<[string, string]> = [];
    for (const file of [...filesUnder(join(t.dataDir, 'blobs')), ...filesUnder(logDir)]) texts.push([file, readFileSync(file, 'utf8')]);
    for (const { name } of t.rows("SELECT name FROM sqlite_master WHERE type = 'table'") as Array<{ name: string }>) {
      for (const row of t.rows(`SELECT * FROM "${name}"`)) texts.push([name, JSON.stringify(row)]);
    }
    expect(texts.some(([where]) => where === 'google_requests')).toBe(true);
    for (const [where, text] of texts) for (const secret of secretsToFind) expect(text.includes(secret), `${secret.slice(0, 20)} in ${where}`).toBe(false);
  });
});
