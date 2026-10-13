import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureEgress, startFixture, type Fixture } from '../../test/web-fixture.js';
import { checkHost, isPublicAddress, publicEgress } from './egress.js';
import { extractReadable, stripTags } from './extract.js';
import { extractIsolated } from './extract-run.js';
import { fetchText } from './fetch.js';
import { createWebFetchTool } from './web-fetch.js';

let site: Fixture;
beforeAll(async () => {
  site = await startFixture();
});
afterAll(() => site.close());

const limits = { maxBytes: 1_000_000, maxRedirects: 5, timeoutMs: 1_000 };
const never = new AbortController().signal;
const fetchFixture = (url: string) => fetchText(fixtureEgress(), url, never, limits);

describe('egress', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['64:ff9b::a00:1', false],
    ['2002:c0a8:101::1', false],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['not an ip', false],
  ])('%s is public: %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it('refuses the loopback address in every written form that the url parser accepts', async () => {
    for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]:4317/api/blobs', 'http://localhost:4317/']) {
      const got = await fetchText(publicEgress, url, never, limits);
      expect(got.ok, url).toBe(false);
      if (!got.ok) expect(got.reason, url).toMatch(/local network|did not resolve/);
    }
  });

  it('refuses the loopback address inside ipv6 for a live server, as a model writes it and as node writes it', async () => {
    // the fixture listens on 127.0.0.1, and a raw connection to ::ffff:7f00:1 reaches it.
    const tool = createWebFetchTool({ egress: publicEgress, limits });
    site.hits.length = 0;
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]']) {
      const url = `http://${host}:${site.port}/about`;
      expect(await fetchText(publicEgress, url, never, limits), url).toMatchObject({ ok: false, reason: expect.stringContaining('local network') });
      const out = await tool.run({ url }, { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock: () => new Date(), signal: never });
      expect(out, url).toMatchObject({ isError: true, content: expect.stringContaining('local network') });
    }
    expect(site.hits).toEqual([]);
  });

  it('refuses a name when one of its addresses is private', async () => {
    expect(await checkHost(fixtureEgress(), 'private.test')).toMatchObject({ ok: false, reason: expect.stringContaining('10.0.0.1') });
  });

  it('refuses other schemes and addresses with a password', async () => {
    for (const url of ['file:///C:/Windows/win.ini', 'ftp://x.test/', 'javascript:alert(1)', 'http://user:pw@shop.test/', 'shop.test/']) {
      expect((await fetchText(fixtureEgress(), url, never, limits)).ok, url).toBe(false);
    }
  });
});

describe('fetchText against a hostile site', () => {
  it('reads a page', async () => {
    const got = await fetchFixture(site.url('shop.test', '/about'));
    expect(got).toMatchObject({ ok: true, status: 200, text: expect.stringContaining('We sell shirts') });
  });

  it('checks every hop of a redirect, so a redirect cannot reach a private address', async () => {
    const got = await fetchFixture(site.url('shop.test', '/redir-private'));
    expect(got).toMatchObject({ ok: false, reason: expect.stringContaining('127.0.0.2') });
    expect(site.hits.some((hit) => hit.path === '/admin')).toBe(false);
  });

  it('stops a redirect loop', async () => {
    expect(await fetchFixture(site.url('shop.test', '/loop'))).toMatchObject({ ok: false, reason: 'more than 5 redirects' });
  });

  it('stops a decompression bomb at the byte limit', async () => {
    const before = process.memoryUsage().rss;
    const got = await fetchFixture(site.url('shop.test', '/bomb'));
    expect(got).toMatchObject({ ok: true, cut: true });
    if (got.ok) expect(got.text.length).toBe(1_000_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(40_000_000);
  });

  it('stops a body that never ends', async () => {
    const started = Date.now();
    expect(await fetchFixture(site.url('shop.test', '/slow'))).toMatchObject({ ok: false, reason: 'no answer within 1 s' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops when the run stops', async () => {
    const run = new AbortController();
    const pending = fetchText(fixtureEgress(), site.url('shop.test', '/slow'), run.signal, { ...limits, timeoutMs: 60_000 });
    setTimeout(() => run.abort(), 50);
    expect(await pending).toMatchObject({ ok: false, reason: 'the run stopped' });
  });

  it('does not download a file that is not text', async () => {
    expect(await fetchFixture(site.url('shop.test', '/pdf'))).toMatchObject({ ok: false, reason: expect.stringContaining('application/pdf') });
  });

  it('decodes the charset of the header', async () => {
    expect(await fetchFixture(site.url('shop.test', '/latin1'))).toMatchObject({ ok: true, text: 'café' });
  });
});

describe('extraction', () => {
  it('keeps the article and its links, and drops the menu and the footer', () => {
    const page = extractReadable(
      `<html><head><title>t</title></head><body><nav><a href="/">Home</a></nav><article><h1>Shirts</h1>${'<p>Cotton shirts keep warm when the days get shorter, and wool is better later. </p>'.repeat(10)}<p>See <a href="/about">about</a>.</p></article><footer>foot</footer></body></html>`,
      'https://shop.example/a',
    );
    expect(page.method).toBe('readability');
    expect(page.text).toContain('about (https://shop.example/about)');
    expect(page.text).not.toContain('foot');
  });

  it('reads a page of 60,000 nested elements without a stack overflow', async () => {
    const got = await fetchFixture(site.url('shop.test', '/deep'));
    expect(got.ok).toBe(true);
    if (got.ok) expect(extractReadable(got.text, got.url).text).toContain('deep text');
  });

  // readability took 7.7 s for 1,000 nested elements, and its time grows with about the cube of the depth.
  it('skips readability on a deep page', () => {
    const started = Date.now();
    const page = extractReadable(`<html><body>${'<div>'.repeat(1000)}deep text${'</div>'.repeat(1000)}</body></html>`, 'https://x.example/');
    expect(page).toMatchObject({ method: 'page', text: 'deep text' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives the plain text when the worker does not finish in time', async () => {
    const page = await extractIsolated('<html><head><title>T</title></head><body><p>one</p><script>x()</script><p>two</p></body></html>', 'https://x.example/', 1);
    expect(page).toMatchObject({ method: 'raw', title: 'T', text: 'one\ntwo', note: expect.stringContaining('took more than') });
  });

  it('reads a page in the worker', async () => {
    const page = await extractIsolated('<html><body><article><h1>Hi</h1><p>text</p></article></body></html>', 'https://x.example/');
    expect(page.text).toContain('text');
    expect(page.method).not.toBe('raw');
  });

  it('strips tags in linear time, also with many unclosed script tags', () => {
    const started = Date.now();
    expect(stripTags(`${'<script>'.repeat(200_000)}x`).text).toBe('');
    expect(stripTags(`<p>a</p>${'<style>b</style>'.repeat(100_000)}<p>c</p>`).text).toBe('a\nc');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // the walk read childNodes in its loop, and linkedom builds that list on each read, so 50,000 siblings never ended.
  it('reads a page of 50,000 siblings in linear time', async () => {
    const got = await fetchFixture(site.url('shop.test', '/many'));
    if (!got.ok) throw new Error(got.reason);
    const started = Date.now();
    const page = extractReadable(got.text, got.url);
    expect(page.text).toContain('the end');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('web_fetch', () => {
  const tool = createWebFetchTool({ egress: fixtureEgress(), limits });
  const ctx = { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock: () => new Date(), signal: never };

  it('gives the main text as untrusted output of its host', async () => {
    const out = await tool.run({ url: site.url('shop.test', '/article') }, ctx);
    expect(out.untrustedSource).toBe(`web:shop.test:${site.port}`);
    expect(out.content).toContain('Title: Shirts in autumn');
    expect(out.content).toContain('Cotton shirts keep warm');
  });

  it('says why a page was refused, also as untrusted text, because a redirect address comes from the server', async () => {
    const out = await tool.run({ url: site.url('shop.test', '/redir-private') }, ctx);
    expect(out).toMatchObject({ isError: true, untrustedSource: `web:shop.test:${site.port}` });
  });
});
