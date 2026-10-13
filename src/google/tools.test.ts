import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, refreshOf, type GoogleHarness } from '../../test/google-harness.js';
import { runTool } from '../../test/run-tool.js';
import { createToolRegistry, type ToolContext, type ToolOutput } from '../tools/registry.js';
import { createGoogleTools, googleToolNames } from './tools.js';
import { isPrivateAddress, oneClick, unsubscribeTargets } from './unsubscribe.js';

let h: GoogleHarness;
afterEach(async () => h?.close());

async function setup(options: { send?: boolean; oneClick?: (target: string) => Promise<{ ok: boolean; sent: boolean; text: string }> } = {}) {
  h = await createGoogleHarness({ accounts: ['personal', 'school'], config: { send: options.send ?? true } });
  h.signedIn('personal');
  h.signedIn('school');
  const tools = createGoogleTools({ accounts: h.accounts, config: h.config, logger: h.logger, ...(options.oneClick ? { oneClick: options.oneClick } : {}) });
  const registry = createToolRegistry(tools);
  const allowed = googleToolNames(h.config);
  let calls = 0;
  const ctx = (id = `call-${++calls}`): ToolContext => ({ runId: 'run-1', sessionKey: 'main', timeZone: 'America/Los_Angeles', clock: () => h.now.value, signal: new AbortController().signal, toolCallId: id });
  return (name: string, input: unknown, context = ctx()): Promise<ToolOutput> => runTool(registry, { id: context.toolCallId!, name: `google__${name}`, input }, allowed, context);
}

const newsletter = {
  id: 'n1',
  headers: {
    From: 'News <news@shop.example>',
    Subject: 'Deals',
    'List-Unsubscribe': '<mailto:unsub@shop.example?subject=stop>, <https://shop.example/u/abc>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Authentication-Results': 'mx.google.com; dkim=pass header.i=@shop.example; spf=pass',
  },
};

describe('gmail_send', () => {
  it('sends through a draft', async () => {
    const call = await setup();
    const out = await call('gmail_send', { account: 'personal', to: ['friend@example.com'], subject: 'Hi', body: 'Hello there' });
    expect(out).toMatchObject({ content: expect.stringContaining('sent from personal') });
    expect(h.fake.sent).toHaveLength(1);
    expect(h.fake.sent[0]!.raw).toContain('To: friend@example.com');
  });

  // the send reached google and went out, but the answer was lost. a plain messages.send cannot tell this from a
  // send that never happened, so the model would try again and the friend gets two mails.
  it('finds out that a send with a lost answer went out', async () => {
    const call = await setup();
    h.fake.fault({ route: 'POST /gmail/v1/users/me/drafts/send', late: true, times: 1 });
    const out = await call('gmail_send', { account: 'personal', to: ['friend@example.com'], subject: 'Hi', body: 'x' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('so it went out');
    expect(h.fake.sent).toHaveLength(1);
  });

  it('finds out that a send with a lost answer did not go out, so a retry is safe', async () => {
    const call = await setup();
    h.fake.fault({ route: 'POST /gmail/v1/users/me/drafts/send', reset: true, times: 1 });
    const out = await call('gmail_send', { account: 'personal', to: ['friend@example.com'], subject: 'Hi', body: 'x' });
    expect(out).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('did not go out') });
    expect(h.fake.sent).toHaveLength(0);
  });

  it('says that the effect is unknown when the check fails too', async () => {
    const call = await setup();
    h.fake.fault({ route: 'POST /gmail/v1/users/me/drafts/send', status: 502, times: 1 });
    h.fake.fault({ route: 'GET /gmail/v1/users/me/drafts/', status: 503, times: 1 });
    const out = await call('gmail_send', { account: 'personal', to: ['friend@example.com'], subject: 'Hi', body: 'x' });
    expect(out).toMatchObject({ isError: true, effect: 'unknown' });
  });

  it('refuses an address that could add a recipient or a header, and folds a line break in the subject', async () => {
    const call = await setup();
    for (const to of ['a@example.com\r\nBcc: eve@evil.example', 'a@example.com, eve@evil.example', 'Eve <eve@evil.example>']) {
      expect(await call('gmail_send', { account: 'personal', to: [to], subject: 'x', body: 'x' })).toMatchObject({ isError: true, effect: 'none' });
    }
    await call('gmail_send', { account: 'personal', to: ['a@example.com'], subject: 'hi\r\nBcc: eve@evil.example', body: 'x' });
    expect(h.fake.sent[0]!.raw).not.toMatch(/^Bcc:/m);
  });

  it('is not a tool while sending is off', async () => {
    await setup({ send: false });
    expect(googleToolNames(h.config)).not.toContain('google__gmail_send');
  });
});

describe('gmail_unsubscribe', () => {
  it('posts only to a target that the header of the message offers', async () => {
    const posted: string[] = [];
    const call = await setup({ oneClick: async (target) => (posted.push(target), { ok: true, sent: true, text: 'the sender answered 200' }) });
    h.fake.deliver('personal', newsletter);
    expect(await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', target: 'https://evil.example/u' })).toMatchObject({ isError: true, effect: 'none' });
    expect(posted).toEqual([]);
    expect(await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', target: 'https://shop.example/u/abc' })).toMatchObject({ content: expect.stringContaining('unsubscribed') });
    expect(posted).toEqual(['https://shop.example/u/abc']);
  });

  it('refuses a one-click post without a passing dkim check', async () => {
    const call = await setup({ oneClick: async () => ({ ok: true, sent: true, text: 'x' }) });
    h.fake.deliver('personal', { ...newsletter, headers: { ...newsletter.headers, 'Authentication-Results': 'mx.google.com; dkim=fail' } });
    expect(await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', target: 'https://shop.example/u/abc' })).toMatchObject({ isError: true, content: expect.stringContaining('dkim') });
  });

  it('unsubscribes by mail through the send path', async () => {
    const call = await setup();
    h.fake.deliver('personal', newsletter);
    const out = await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', target: 'mailto:unsub@shop.example?subject=stop' });
    expect(out.content).toContain('sent from personal to unsub@shop.example');
    expect(h.fake.sent[0]!.raw).toContain('Subject: stop');
  });

  it('keeps only https and mailto targets', () => {
    expect(unsubscribeTargets('<http://a.example/u>, <javascript:alert(1)>, <https://b.example/u>, <mailto:x@c.example>')).toEqual(['https://b.example/u', 'mailto:x@c.example']);
  });

  // a sender writes the header, so a link can point at the pc, the router or a metadata address.
  it('never posts to a private address', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0.0.0.0', '100.64.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(address), address).toBe(false);
    expect(await oneClick('https://127.0.0.1:1/u')).toMatchObject({ ok: false, sent: false, text: expect.stringContaining('private address') });
    expect(await oneClick('https://[::1]:1/u')).toMatchObject({ ok: false, sent: false });
    // a name that resolves to a private address is refused inside the connect, after the dns answer.
    expect(await oneClick('https://localhost:1/u')).toMatchObject({ ok: false, sent: false, text: expect.stringContaining('private address') });
    expect(await oneClick('http://shop.example/u')).toMatchObject({ ok: false, sent: false });
  });
});

describe('read tools', () => {
  it('reads all accounts, names an account that fails, and marks the output with each account', async () => {
    const call = await setup();
    h.fake.deliver('personal', { id: 'p1', headers: { From: 'a@x.example', Subject: 'hello personal' } });
    h.fake.deliver('school', { id: 's1', headers: { From: 'b@x.example', Subject: 'hello school' } });
    h.fake.revoke(refreshOf('school'));
    const out = await call('gmail_search', { account: 'all', query: 'hello' });
    expect(out.content).toContain('hello personal');
    expect(out.content).toContain('gmail_search failed for school');
    expect(out.isError).toBeUndefined();
    expect(out.untrustedSource).toBe('gmail:personal, gmail:school');
  });

  it('refuses an account alias that the config does not have', async () => {
    const call = await setup();
    expect(await call('gmail_search', { account: 'boss', query: 'x' })).toMatchObject({ isError: true, content: expect.stringContaining('invalid input') });
  });

  it('shows the unsubscribe targets in the thread', async () => {
    const call = await setup();
    h.fake.deliver('personal', { ...newsletter, body: 'Big deals today' });
    const out = await call('gmail_read_thread', { account: 'personal', threadId: 'n1' });
    expect(out.content).toContain('unsubscribe targets: mailto:unsub@shop.example?subject=stop https://shop.example/u/abc (one-click)');
    expect(out.content).toContain('Big deals today');
  });
});

describe('calendar writes', () => {
  it('creates an event once, also when the same call runs again', async () => {
    const call = await setup();
    const input = { account: 'personal', summary: 'Dentist', start: '2026-10-20T09:00:00-07:00', end: '2026-10-20T10:00:00-07:00' };
    const context = { runId: 'run-1', sessionKey: 'main', timeZone: 'UTC', clock: () => h.now.value, signal: new AbortController().signal, toolCallId: 'same' };
    expect((await call('calendar_create_event', input, context)).content).toMatch(/^created event okc/);
    expect((await call('calendar_create_event', input, context)).content).toContain('already exists');
    expect(h.fake.mailbox('personal').events.size).toBe(1);
  });

  // the approval flow reads the effect: none puts the approval back to pending, unknown tells the owner to check.
  it('says none for a refused write and unknown for a write without an answer', async () => {
    const call = await setup();
    const input = { account: 'personal', summary: 'x', start: '2026-10-20T09:00:00-07:00', end: '2026-10-20T10:00:00-07:00' };
    h.fake.fault({ route: 'POST /calendar/v3/calendars/primary/events', status: 400, times: 1 });
    expect(await call('calendar_create_event', input)).toMatchObject({ isError: true, effect: 'none' });
    h.fake.fault({ route: 'POST /calendar/v3/calendars/primary/events', status: 503, times: 1 });
    expect(await call('calendar_create_event', input)).toMatchObject({ isError: true, effect: 'unknown' });
    h.fake.fault({ route: 'POST /calendar/v3/calendars/primary/events', late: true, times: 1 });
    expect(await call('calendar_create_event', input)).toMatchObject({ isError: true, effect: 'unknown' });
  });

  it('treats a repeated delete as done', async () => {
    const call = await setup();
    h.fake.upsertEvent('personal', { id: 'e1', summary: 'x', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { dateTime: '2026-10-20T10:00:00Z' } });
    expect((await call('calendar_delete_event', { account: 'personal', eventId: 'e1' })).content).toContain('deleted event e1');
    expect((await call('calendar_delete_event', { account: 'personal', eventId: 'e1' })).content).toContain('already deleted');
  });
});
