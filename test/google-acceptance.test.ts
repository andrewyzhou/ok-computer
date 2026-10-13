import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCOPES } from '../src/google/config.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { fakeResponse } from '../src/models/fake.js';
import type { ModelCall } from '../src/models/types.js';
import { createLogger } from '../src/observability/logger.js';
import { sessionTaint } from '../src/policy/store.js';
import { createTestApp } from './app-harness.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';
import { CLIENT_SECRET, refreshOf } from './google-harness.js';

const pdt = (time: string, day = '2026-10-13') => new Date(`${day}T${time}:00-07:00`).toISOString();

let fake: FakeGoogle;
afterEach(async () => fake?.close());

// the fake model answers by the kind of request, because the poll and the heartbeat can run in either order.
function router(onMain: (call: ModelCall) => ReturnType<typeof fakeResponse>) {
  return async (call: ModelCall) => {
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
    return onMain(call);
  };
}

function filesUnder(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out = statSync(path).isDirectory() ? [...out, ...filesUnder(path)] : [...out, path];
  }
  return out;
}

describe('google acceptance', () => {
  it('polls into signals, tells the owner about a deadline missing from the calendar, holds an unsubscribe for approval, and keeps every token out of logs and blobs', async () => {
    fake = await startFakeGoogle();
    fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead];
    for (const alias of ['personal', 'school']) fake.addAccount(alias, `${alias}@example.com`, refreshOf(alias));
    fake.upsertEvent('personal', { id: 'd1', summary: 'Dentist', start: { dateTime: '2026-10-20T16:00:00Z' }, end: { dateTime: '2026-10-20T17:00:00Z' }, organizer: { self: true } });
    const secrets = createMemorySecretStore({
      'google.client': JSON.stringify({ client_id: 'fake-client', client_secret: CLIENT_SECRET }),
      'google.personal': refreshOf('personal'),
      'google.school': refreshOf('school'),
    });
    const steps = Array.from({ length: 30 }, () =>
      router(() =>
        fakeResponse({
          toolCalls: [{ id: 'u1', name: 'google__gmail_unsubscribe', input: { account: 'personal', messageId: 'n1', target: 'https://shop.example/u/abc' } }],
        }),
      ),
    );
    // the logger writes files, so the test can read every line that the run wrote.
    const logDir = mkdtempSync(join(tmpdir(), 'okc-google-logs-'));
    const t = createTestApp(steps, {
      start: pdt('09:00'),
      config: {
        slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['fake/m'] } },
        heartbeat: { every: '1h' },
        google: { accounts: [{ alias: 'personal', email: 'personal@example.com' }, { alias: 'school' }] },
      },
      deps: {
        secrets,
        googleEndpoints: { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke` },
        logger: createLogger({ dir: logDir, consoleLevel: 'off' }),
      },
    });
    // the first token request fails, and the server quotes the request body with the refresh token and the client
    // secret in it.
    // the auth library retries a token post three times, and both accounts refresh at once, so the fault outlasts the
    // retries of both.
    fake.fault({ route: 'POST /token', status: 500, times: 8, echoAuth: true });
    for (const alias of ['personal', 'school']) {
      t.db.prepare("UPDATE google_accounts SET status = 'ok', email = ?, authorizedAt = ? WHERE alias = ?").run(`${alias}@example.com`, '2026-10-01T00:00:00Z', alias);
    }
    await t.app.start();

    // the first poll fails at the token endpoint. the second poll is the baseline, and the mail after it is news.
    await t.at(pdt('09:15'));
    expect(t.rows("SELECT COUNT(*) AS n FROM google_accounts WHERE lastError LIKE '%injected fault%'")).toEqual([{ n: 2 }]);
    await t.at(pdt('09:30'));
    fake.deliver('school', { id: 'm1', headers: { From: 'Teacher <t@school.example>', Subject: 'Essay due Oct 20', Date: 'Tue, 13 Oct 2026 09:20:00 -0700' }, snippet: 'please submit the essay by Oct 20' });
    fake.deliver('personal', {
      id: 'n1',
      headers: {
        From: 'News <news@shop.example>',
        Subject: 'Deals',
        'List-Unsubscribe': '<https://shop.example/u/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Authentication-Results': 'mx.google.com; dkim=pass',
      },
    });
    // a server error that echoes the authorization header. its text reaches the log and the sync row.
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
    expect(t.rows("SELECT COUNT(*) AS n FROM model_calls WHERE slot = 'utility'")).not.toEqual([{ n: 0 }]);

    // the heartbeat runs each hour. the one at 10:00 can run before or after the poll of 10:00.
    await t.at(pdt('11:00'));
    expect(t.printed()).toContain('okc> Your essay is due Oct 20, and it is not on your calendar.');
    // the digest is shown one time: the run that saw the deadline marked it handled, and that run read school mail.
    const [deadline] = t.rows("SELECT handledAs, handledBy FROM integration_events WHERE externalId = 'm1'");
    expect(deadline!.handledAs).toBe('notified');
    const key = `heartbeat:${String(deadline!.handledBy)}`;
    expect(sessionTaint(t.db, key).map((each) => each.source)).toEqual(expect.arrayContaining(['gmail:school']));
    expect(JSON.stringify(t.model.calls.find((call) => JSON.stringify(call.messages).includes('date_not_on_calendar'))?.messages)).toMatch(/<untrusted source=[^>]*gmail:school/);
    // a notification that went out once is not sent again by a later heartbeat.
    expect(t.printed().split('Your essay is due Oct 20').length - 1).toBe(1);

    // an unsubscribe waits for the owner. nothing went to the sender.
    await t.say('unsubscribe me from the shop newsletter');
    const approvals = t.rows('SELECT toolName, status FROM approvals');
    expect(approvals).toEqual([{ toolName: 'google__gmail_unsubscribe', status: 'pending' }]);
    expect(t.printed()).toContain('https://shop.example/u/abc');
    expect(t.rows("SELECT name, outcome FROM tool_calls WHERE name = 'google__gmail_unsubscribe'")).toHaveLength(1);

    await t.app.stop();

    // every token and the client secret stay out of the logs, the blobs and the database.
    const issued = new Set(fake.requests.map((each) => each.authorization?.replace(/^Bearer /, '')).filter((each): each is string => !!each));
    expect(issued.size).toBeGreaterThan(0);
    // the raw form and the percent-encoded form of a form body or a query string.
    const secretsToFind = [...issued, refreshOf('personal'), refreshOf('school'), CLIENT_SECRET].flatMap((each) => [each, encodeURIComponent(each)]);
    const texts: Array<[string, string]> = [];
    for (const file of [...filesUnder(join(t.dataDir, 'blobs')), ...filesUnder(logDir)]) texts.push([file, readFileSync(file, 'utf8')]);
    for (const { name } of t.rows("SELECT name FROM sqlite_master WHERE type = 'table'") as Array<{ name: string }>) {
      for (const row of t.rows(`SELECT * FROM "${name}"`)) texts.push([name, JSON.stringify(row)]);
    }
    for (const [where, text] of texts) for (const secret of secretsToFind) expect(text.includes(secret), `${secret.slice(0, 20)} in ${where}`).toBe(false);
  });
});
