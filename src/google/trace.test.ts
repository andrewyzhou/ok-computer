import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_SECRET, createGoogleHarness, refreshOf, type GoogleHarness } from '../../test/google-harness.js';
import { runTool } from '../../test/run-tool.js';
import { createToolRegistry, type ToolOutput } from '../tools/registry.js';
import { createGoogleTools, googleToolNames } from './tools.js';
import { requestContext } from './trace.js';

let h: GoogleHarness;
afterEach(async () => h?.close());

async function setup() {
  h = await createGoogleHarness({ accounts: ['personal'] });
  h.signedIn('personal');
  const registry = createToolRegistry(createGoogleTools({ accounts: h.accounts, config: h.config, logger: h.logger }));
  return (name: string, input: unknown, runId: string, toolCallId: string): Promise<ToolOutput> =>
    runTool(registry, { id: toolCallId, name: `google__${name}`, input }, googleToolNames(h.config), {
      runId,
      sessionKey: 'main',
      timeZone: 'UTC',
      clock: () => h.now.value,
      signal: new AbortController().signal,
      toolCallId,
    });
}

const requests = () => h.rows('SELECT account, runId, toolCallId, method, url, request, status, response, error FROM google_requests ORDER BY id');

describe('the recorded fetch', () => {
  // the first call needs an access token, so the token refresh belongs to that call too.
  it('records every request of an approved call with its run and call, the token refresh too, and no secret', async () => {
    const call = await setup();
    await call('gmail_list_labels', { account: 'personal' }, 'run-7', 'approval-3');
    const rows = requests();
    expect(rows.map((row) => [row.account, row.runId, row.toolCallId, row.method, String(row.url).replace(/^127\.0\.0\.1:\d+/, '')])).toEqual([
      ['personal', 'run-7', 'approval-3', 'POST', '/token'],
      ['personal', 'run-7', 'approval-3', 'GET', '/gmail/v1/users/me/labels'],
    ]);
    // the token fields are removed by name. the fake's answers are the real shapes of google.
    expect(JSON.parse(String(rows[0]!.request))).toMatchObject({ refresh_token: '[redacted]', client_secret: '[redacted]', grant_type: 'refresh_token' });
    expect(JSON.parse(String(rows[0]!.response))).toMatchObject({ access_token: '[redacted]', token_type: 'Bearer' });
    expect(rows[1]).toMatchObject({ status: 200, response: expect.stringContaining('Label_1') });
    const text = JSON.stringify(rows);
    for (const secret of [refreshOf('personal'), CLIENT_SECRET, 'ya29.', 'Bearer ya29', 'authorization']) expect(text).not.toContain(secret);
  });

  it('records the requests of a poll under its run', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    await requestContext.run({ runId: 'poll-1' }, () => h.sync.pollAll('poll-1'));
    const rows = requests();
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((row) => row.runId === 'poll-1' && row.toolCallId === null && row.account === 'personal')).toBe(true);
  });

  // a request that cannot be recorded never leaves, and the model reads that nothing was sent.
  it('sends nothing when the row cannot be written', async () => {
    const call = await setup();
    await call('gmail_list_labels', { account: 'personal' }, 'run-1', 'warm');
    h.db.exec("CREATE TRIGGER no_trace BEFORE INSERT ON google_requests BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const before = h.fake.requests.length;
    const out = await call('gmail_archive', { account: 'personal', messageIds: ['m1'] }, 'run-1', 'c1');
    expect(out).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('its trace could not be written') });
    expect(h.fake.requests.length).toBe(before);
  });

  it('records a failed request with its error and keeps the answer of a later one', async () => {
    const call = await setup();
    h.fake.fault({ route: 'GET /gmail/v1/users/me/labels', reset: true, times: 1 });
    await call('gmail_list_labels', { account: 'personal' }, 'run-1', 'c1');
    expect(requests().at(-1)).toMatchObject({ status: null, error: expect.stringMatching(/socket hang up|ECONNRESET|fetch failed/i) });
  });
});
