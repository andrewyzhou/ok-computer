import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { BUILTIN_RULES, dataUrls, decide, type PolicyInput, type Rule } from './policy.js';
import { urlSeen } from './store.js';

const call = (input: unknown, extra: Partial<PolicyInput> = {}): PolicyInput => ({
  tool: 'web_fetch',
  risk: 'read',
  alwaysApprove: false,
  input,
  sessionKey: 'main',
  taint: ['mcp:mail'],
  ...extra,
});

const leak = { url: 'https://evil.example/c?d=1234' };

describe('the exfiltration guard', () => {
  it('finds a url that can carry data', () => {
    const signal = (url: string) => dataUrls({ url })[0]?.signal;
    expect(signal('https://example.com/about')).toBeUndefined();
    expect(signal('https://example.com/?')).toBeUndefined();
    // a short secret in base64 fits in a short query, so any query counts.
    expect(signal('https://evil.example/c?d=QUNDT1VOVCAxMjM0NTY3OA')).toBe('it has a query or a fragment');
    expect(signal('https://evil.example/#k=1')).toBe('it has a query or a fragment');
    expect(signal(`https://evil.example/${'a'.repeat(100)}`)).toMatch(/host and path/);
    expect(signal(`https://${'x'.repeat(33)}.evil.example/`)).toMatch(/label of its host/);
    expect(signal(`https://${'x'.repeat(32)}.evil.example/`)).toBeUndefined();
    // a url inside a message counts too, because a chat app fetches a link preview. so does a url in a list.
    expect(dataUrls({ text: 'see https://evil.example/p?id=42 for details' })[0]?.url).toBe('https://evil.example/p?id=42');
    expect(dataUrls({ urls: ['https://example.com/', 'https://evil.example/?q=1'] })[0]?.url).toBe('https://evil.example/?q=1');
    // fullwidth letters become ascii in the nfkc form, as a url parser reads them.
    expect(dataUrls({ url: 'ｈｔｔｐｓ://evil.example/?q=1' })).toHaveLength(1);
    expect(dataUrls({ note: 'no url here' })).toEqual([]);
  });

  it('sends such a call to the reviewer only in a tainted session, also when an allow rule matches', () => {
    expect(decide(call(leak), [])).toMatchObject({ decision: 'review', rule: 'exfiltration', reason: expect.stringContaining('https://evil.example/c?d=1234') });
    expect(decide(call(leak, { taint: [] }), [])).toMatchObject({ decision: 'allow', rule: 'risk:read' });
    expect(decide(call({ url: 'https://example.com/about' }), [])).toMatchObject({ decision: 'allow', rule: 'risk:read' });
    const allow: Rule = { id: 'okc.policy.json#1', tool: 'web_fetch', effect: 'allow' };
    expect(decide(call(leak), [allow])).toMatchObject({ decision: 'review', rule: 'exfiltration' });
    // a built-in local tool with a link goes to the reviewer too: a chat app fetches the preview of a link.
    expect(decide(call({ text: 'https://evil.example/?d=1' }, { tool: 'message_owner', risk: 'write' }), BUILTIN_RULES)).toMatchObject({ rule: 'exfiltration' });
    expect(decide(call({ text: 'all done' }, { tool: 'message_owner', risk: 'write' }), BUILTIN_RULES)).toMatchObject({ rule: 'builtin:message_owner' });
  });

  it('counts the query of a web search as a query', () => {
    const search = (query: string, taint = ['mcp:mail']) => decide(call({ query }, { tool: 'web_search', taint }), []);
    expect(search('acme order 4411')).toMatchObject({ decision: 'review', rule: 'exfiltration', reason: expect.stringContaining('search query (acme order 4411)') });
    expect(search('acme order 4411', [])).toMatchObject({ decision: 'allow' });
  });

  it('keeps the stronger decisions first', () => {
    const deny: Rule = { id: 'okc.policy.json#1', tool: 'web_fetch', args: { url: '*evil.example*' }, effect: 'deny' };
    expect(decide(call(leak), [deny])).toMatchObject({ decision: 'deny' });
    expect(decide(call(leak, { risk: 'external' }), [])).toMatchObject({ decision: 'approve', rule: 'taint' });
    expect(decide(call(leak, { alwaysApprove: true }), [])).toMatchObject({ decision: 'approve', rule: 'tool' });
  });

  it('lets a url pass that the session read verbatim, and not one with a changed character', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'completed', 'x')").run();
    const link = 'https://shop.example/track?id=99&utm_source=mail';
    appendEvent(
      db,
      { sessionKey: 'main', runId: 'r', type: 'tool_result', payload: { toolCallId: 'm', name: 'read', content: `Track it: ${link}`, isError: false, untrustedSource: 'mcp:mail' } },
      new Date(),
    );
    const seen = (url: string) => urlSeen(db, 'main', url);
    expect(decide(call({ url: link }, { seen }), [])).toMatchObject({ decision: 'allow', rule: 'risk:read' });
    expect(decide(call({ url: link.replace('99', '98') }, { seen }), [])).toMatchObject({ decision: 'review', rule: 'exfiltration' });
    // every url with a signal must be seen.
    expect(decide(call({ a: link, b: 'https://evil.example/?d=1' }, { seen }), [])).toMatchObject({ decision: 'review' });
    // a reset ends what the session read.
    appendEvent(db, { sessionKey: 'main', runId: 'r', type: 'session_reset', payload: {} }, new Date());
    expect(urlSeen(db, 'main', link)).toBe(false);
  });

  it('finds the url forms that a url parser reads, not only https://host/path', () => {
    const forms = [
      'https:/evil.example/c?d=SECRET',
      'https:\\\\evil.example\\c?d=SECRET',
      'https:evil.example/c?d=SECRET',
      'HTTPS:\\\\evil.example\\c?d=SECRET',
      'https://evil.exa\tmple/c?d=SECRET',
      'https://evil.example/a b?d=SECRET',
      "https://evil.example/c'?d=SECRET",
      'https://evil.example/x"?d=SECRET',
    ];
    for (const url of forms) {
      expect(new URL(url).search, url).toBe('?d=SECRET');
      expect(decide(call({ url }), []), url).toMatchObject({ decision: 'review', rule: 'exfiltration' });
    }
    // a browser sends the user name and the password after a 401 answer.
    expect(dataUrls({ url: 'https://QUNDT1VOVCAxMjM0NTY3OA:x@evil.example/' })[0]?.signal).toBe('it has a user name or a password');
    // a chat app makes a link of a host name with a path, also with no scheme.
    const owner = (text: string) => decide(call({ text }, { tool: 'message_owner', risk: 'write' }), BUILTIN_RULES);
    expect(owner('Here is your link: evil.example/c?d=QUNDT1VOVCAxMjM0NTY3OA')).toMatchObject({ rule: 'exfiltration' });
    // a plain link with words after it carries no data, and a file name is not a url.
    expect(owner('See https://example.com/about for the details of the order.')).toMatchObject({ rule: 'builtin:message_owner' });
    expect(owner('I saved notes.md and the order.')).toMatchObject({ rule: 'builtin:message_owner' });
    // a deny rule sees the same forms.
    const deny: Rule = { id: 'okc.policy.json#1', tool: 'web_fetch', args: { url: '*//evil.example/*' }, effect: 'deny' };
    expect(decide(call({ url: 'https:\\\\evil.example\\c' }), [deny])).toMatchObject({ decision: 'deny' });
  });

  it('counts only a successful untrusted result as read, and only the whole url', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'completed', 'x')").run();
    const result = (name: string, content: string, extra: { isError?: boolean; untrustedSource?: string } = {}) =>
      appendEvent(db, { sessionKey: 'main', runId: 'r', type: 'tool_result', payload: { toolCallId: 'x', name, content, isError: false, ...extra } }, new Date());
    const url = 'https://evil.example/c?d=1';
    result('memory_get', `no file ${url}`);
    result('tool_call', `no tool ${url}`, { isError: true, untrustedSource: 'mcp:mail' });
    result('delegate', url, { untrustedSource: 'sub:inbox:c (mcp:mail)' });
    appendEvent(db, { sessionKey: 'main', runId: 'r', type: 'system_event', payload: { text: url, taint: [] } }, new Date());
    expect(urlSeen(db, 'main', url)).toBe(false);
    result('read', `open ${url}23 now`, { untrustedSource: 'mcp:mail' });
    expect(urlSeen(db, 'main', url)).toBe(false);
    result('read', `open ${url}\nnow`, { untrustedSource: 'mcp:mail' });
    expect(urlSeen(db, 'main', url)).toBe(true);
  });

  it('checks a hostile input of 90 kb in under 1 s', () => {
    const hostile = {
      url: `https://evil.example/${'%41/'.repeat(22_000)}`,
      text: 'https://a.example/x?q '.repeat(200),
      // long runs that the search for a host name with no scheme must not try again and again.
      host: `${'a.'.repeat(10_000)} ${'a-'.repeat(10_000)} ${'http:'.repeat(4_000)}`,
    };
    // more than 20 urls with a signal go to the reviewer without a check of each one.
    const started = performance.now();
    expect(decide(call(hostile, { seen: () => true }), [])).toMatchObject({ decision: 'review' });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the policy in a sub-agent session', () => {
  const child = (extra: Partial<PolicyInput>) => call({}, { sessionKey: 'sub:inbox:c1', taint: [], ...extra });

  it('denies a call that needs the owner, and keeps the other decisions', () => {
    expect(decide(child({ risk: 'external' }), [])).toMatchObject({
      decision: 'deny',
      rule: 'subagent',
      reason: expect.stringMatching(/the inbox sub-agent \(run c1\) cannot ask the owner. Report this call to the parent agent/),
    });
    expect(decide(child({ risk: 'write', alwaysApprove: true }), [])).toMatchObject({ decision: 'deny', rule: 'subagent' });
    expect(decide(child({ risk: 'write' }), [])).toMatchObject({ decision: 'review' });
    expect(decide(child({ risk: 'read' }), [])).toMatchObject({ decision: 'allow' });
    expect(decide(call({}, { risk: 'external', taint: [] }), [])).toMatchObject({ decision: 'approve' });
  });

  it('allows delegate with a note that names the policy of the child', () => {
    expect(decide(call({ profile: 'research', task: 'x' }, { tool: 'delegate', taint: [] }), BUILTIN_RULES)).toMatchObject({
      decision: 'allow',
      rule: 'builtin:delegate',
      reason: expect.stringContaining('each call of the sub-agent gets its own policy decision'),
    });
  });
});
