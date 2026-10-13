import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, refreshOf, type GoogleHarness } from '../../test/google-harness.js';
import { runTool } from '../../test/run-tool.js';
import { createToolRegistry, type ToolContext, type ToolOutput } from '../tools/registry.js';
import { createGoogleTools, googleToolNames } from './tools.js';
import { isPrivateAddress, oneClick, planUnsubscribe, unsubscribeTargets, type OneClickResult } from './unsubscribe.js';

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

const SENDER = 'news@shop.example';
const newsletter = {
  id: 'n1',
  headers: {
    From: 'News <news@shop.example>',
    Subject: 'Deals',
    'List-Unsubscribe': '<mailto:unsub@shop.example?subject=stop>, <https://shop.example/u/abc>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Authentication-Results': 'mx.google.com; dkim=pass header.i=@shop.example header.s=s1 header.b=Sig0; spf=pass',
    'DKIM-Signature': 'v=1; a=rsa-sha256; d=shop.example; s=s1;\r\n h=From:Subject:List-Unsubscribe:List-Unsubscribe-Post; bh=x; b=Sig0abc',
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

  // without an answer google can still be sending, and the draft goes only when the send ends. a second approval after
  // "did not go out" could then send the mail twice.
  it('says that the effect is unknown when a send without an answer still has its draft', async () => {
    const call = await setup();
    h.fake.fault({ route: 'POST /gmail/v1/users/me/drafts/send', reset: true, times: 1 });
    const out = await call('gmail_send', { account: 'personal', to: ['friend@example.com'], subject: 'Hi', body: 'x' });
    expect(out).toMatchObject({ isError: true, effect: 'unknown', content: expect.stringContaining('google can still be sending it') });
    expect(h.fake.sent).toHaveLength(0);
  });

  it('finds out that a send with a 5xx answer did not go out, so a retry is safe', async () => {
    const call = await setup();
    h.fake.fault({ route: 'POST /gmail/v1/users/me/drafts/send', status: 503, times: 1 });
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

  it('refuses an address that could add a recipient or a header, and a line break in a header field', async () => {
    const call = await setup();
    for (const to of ['a@example.com\r\nBcc: eve@evil.example', 'a@example.com, eve@evil.example', 'Eve <eve@evil.example>']) {
      expect(await call('gmail_send', { account: 'personal', to: [to], subject: 'x', body: 'x' })).toMatchObject({ isError: true, effect: 'none' });
    }
    for (const field of [{ subject: 'hi\r\nBcc: eve@evil.example' }, { subject: 'x', inReplyTo: '<a@b>\nBcc: eve@evil.example' }]) {
      expect(await call('gmail_send', { account: 'personal', to: ['a@example.com'], body: 'x', ...field })).toMatchObject({ isError: true, content: expect.stringContaining('a line break is not allowed') });
    }
    expect(h.fake.sent).toEqual([]);
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
    // a refusal has no effect field. the approval flow would give a call without effect back to the owner, and a second
    // approval of the same call cannot help.
    expect(await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', sender: SENDER, target: 'https://evil.example/u' })).toEqual({
      content: 'google__gmail_unsubscribe did not run: the message does not offer "https://evil.example/u". gmail_read_thread shows the targets that it offers.',
      isError: true,
    });
    expect(posted).toEqual([]);
    expect(await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', sender: 'News@Shop.example', target: 'https://shop.example/u/abc' })).toMatchObject({ content: expect.stringContaining('unsubscribed') });
    expect(posted).toEqual(['https://shop.example/u/abc']);
  });

  it('refuses a one-click post without a passing dkim check', async () => {
    const call = await setup({ oneClick: async () => ({ ok: true, sent: true, text: 'x' }) });
    h.fake.deliver('personal', { ...newsletter, headers: { ...newsletter.headers, 'Authentication-Results': 'mx.google.com; dkim=fail' } });
    expect(await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', sender: SENDER, target: 'https://shop.example/u/abc' })).toMatchObject({ isError: true, content: expect.stringContaining('dkim') });
  });

  // a forger can add a header that says dkim=pass, or sign the mail with a domain of its own. only the result that
  // gmail put on top counts, and only for a signature of the from domain that covers both unsubscribe headers.
  it('accepts only an aligned dkim pass of gmail that covers the unsubscribe headers', () => {
    const plan = (headers: Array<[string, string]>) =>
      planUnsubscribe(
        { payload: { headers: [['From', 'Bank <alerts@bank.example>'], ['List-Unsubscribe', '<https://evil.example/u>'], ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'], ...headers].map(([name, value]) => ({ name, value })) } },
        'alerts@bank.example',
        'https://evil.example/u',
        false,
      ).way;
    const signature = (d: string, h = 'From:List-Unsubscribe:List-Unsubscribe-Post') => ['DKIM-Signature', `v=1; d=${d}; s=s1; h=${h}; b=Sig0abc`] as [string, string];
    const results = (value: string) => ['Authentication-Results', value] as [string, string];
    expect(plan([results('mx.google.com; dkim=pass header.i=@bank.example header.b=Sig0'), signature('bank.example')])).toBe('one-click');
    expect(plan([results('mx.google.com; dkim=pass (good signature) header.d=mail.bank.example'), signature('mail.bank.example')])).toBe('one-click');
    // the sender added a second header below the one of gmail.
    expect(plan([results('mx.google.com; dkim=fail header.i=@bank.example'), results('mx.google.com; dkim=pass header.i=@bank.example'), signature('bank.example')])).toBe('refused');
    // a header from another server than gmail.
    expect(plan([results('forged.example; dkim=pass header.i=@bank.example'), signature('bank.example')])).toBe('refused');
    // a pass for the domain of the forger, with dmarc failing for the from domain.
    expect(plan([results('mx.google.com; dkim=pass header.i=@evil.example; dmarc=fail header.from=bank.example'), signature('evil.example')])).toBe('refused');
    expect(plan([results('mx.google.com; dkim=pass header.i=@ank.example'), signature('ank.example')])).toBe('refused');
    // the signature does not cover the unsubscribe headers, so they were added after it.
    expect(plan([results('mx.google.com; dkim=pass header.i=@bank.example'), signature('bank.example', 'From:Subject')])).toBe('refused');
    // a second signature of the domain covers them, but it is not the one that passed.
    expect(plan([results('mx.google.com; dkim=pass header.i=@bank.example header.b=Sig0'), signature('bank.example', 'From'), ['DKIM-Signature', 'v=1; d=bank.example; h=List-Unsubscribe:List-Unsubscribe-Post; b=Badx']])).toBe('refused');
  });

  // the card shows the sender, so the owner approves a sender. a text test of the from header would let a display
  // name with the bank's address pass.
  it('refuses a message whose from address is not exactly the sender', async () => {
    const posted: string[] = [];
    const call = await setup({ oneClick: async (target) => (posted.push(target), { ok: true, sent: true, text: 'x' }) });
    for (const from of ['"bank@x.example" <evil@y.example>', 'bank@x.example.evil.example', 'Bank <bank@x.example>, Eve <evil@y.example>', 'Eve <evil@y.example>, Bank <bank@x.example>', 'not an address']) {
      h.fake.deliver('personal', { ...newsletter, headers: { ...newsletter.headers, From: from } });
      const out = await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', sender: 'bank@x.example', target: 'https://shop.example/u/abc' });
      expect(out, from).toMatchObject({ isError: true, content: expect.stringContaining('not from "bank@x.example"') });
      expect(out.effect).toBeUndefined();
    }
    expect(posted).toEqual([]);
  });

  it('gives a refusal of the post itself no effect, and an unreached sender the effect none', async () => {
    let answer: OneClickResult = { ok: false, sent: false, refused: true, text: 'the unsubscribe link points at a private address (127.0.0.1)' };
    const call = await setup({ oneClick: async () => answer });
    h.fake.deliver('personal', newsletter);
    const input = { account: 'personal', messageId: 'n1', sender: SENDER, target: 'https://shop.example/u/abc' };
    expect((await call('gmail_unsubscribe', input)).effect).toBeUndefined();
    answer = { ok: false, sent: false, text: 'connect ECONNREFUSED' };
    expect((await call('gmail_unsubscribe', input)).effect).toBe('none');
    answer = { ok: false, sent: true, text: 'socket hang up' };
    expect((await call('gmail_unsubscribe', input)).effect).toBe('unknown');
  });

  it('unsubscribes by mail through the send path', async () => {
    const call = await setup();
    h.fake.deliver('personal', newsletter);
    const out = await call('gmail_unsubscribe', { account: 'personal', messageId: 'n1', sender: SENDER, target: 'mailto:unsub@shop.example?subject=stop' });
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
    expect(await oneClick('https://localhost:1/u')).toMatchObject({ ok: false, sent: false, refused: true, text: expect.stringContaining('private address') });
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
    expect((await call('calendar_delete_event', { account: 'personal', eventId: 'e1', currentTitle: 'x' })).content).toContain('deleted event e1');
    expect((await call('calendar_delete_event', { account: 'personal', eventId: 'e1', currentTitle: 'x' })).content).toContain('already deleted');
  });

  // the owner approved a change of the event with the title on the card. another event under that id is not it.
  it('changes or deletes nothing when the event has another title now, and the refusal is not a call without effect', async () => {
    const call = await setup();
    h.fake.upsertEvent('personal', { id: 'e1', summary: 'Board meeting', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { dateTime: '2026-10-20T10:00:00Z' } });
    const update = await call('calendar_update_event', { account: 'personal', eventId: 'e1', currentTitle: 'Lunch', summary: 'moved' });
    expect(update).toEqual({ content: 'google__calendar_update_event did not run: the event e1 has another title now, not "Lunch". calendar_list_events shows its title.', isError: true });
    expect(await call('calendar_delete_event', { account: 'personal', eventId: 'e1', currentTitle: 'Lunch' })).toMatchObject({ isError: true });
    expect(h.fake.mailbox('personal').events.get('e1')).toMatchObject({ summary: 'Board meeting', status: 'confirmed' });
    expect((await call('calendar_update_event', { account: 'personal', eventId: 'e1', currentTitle: 'Board meeting', summary: 'moved' })).content).toBe('updated event e1 in personal.');
    expect(h.fake.mailbox('personal').events.get('e1')).toMatchObject({ summary: 'moved' });
  });

  it('invites the attendees of a new event, and sends no update for a private one', async () => {
    const call = await setup();
    const base = { account: 'personal', summary: 'Kickoff', start: '2026-10-20T09:00:00-07:00', end: '2026-10-20T10:00:00-07:00' };
    expect((await call('calendar_create_event', { ...base, attendees: ['ana@example.com'] })).content).toMatch(/invited ana@example.com/);
    await call('calendar_create_event', base);
    const inserts = h.fake.requests.filter((each) => each.method === 'POST' && each.path.startsWith('/calendar/v3/calendars/primary/events'));
    expect(inserts.map((each) => new URL(each.path, 'http://x').searchParams.get('sendUpdates'))).toEqual(['all', 'none']);
    expect(JSON.parse(inserts[0]!.body).attendees).toEqual([{ email: 'ana@example.com' }]);
    expect(await call('calendar_create_event', { ...base, attendees: ['Ana <ana@example.com>'] })).toMatchObject({ isError: true, effect: 'none' });
  });
});
