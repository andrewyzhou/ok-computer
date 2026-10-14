import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
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

  // a server on this pc that listens on every address, as node does without a host, answers on the global ipv6 address
  // of the pc. the test skips on a pc without one.
  const globalV6 = Object.values(networkInterfaces())
    .flat()
    .find((each) => each && each.family === 'IPv6' && !each.internal && /^[23]/.test(each.address))?.address;
  it.skipIf(!globalV6)('refuses the global ipv6 address of this pc for a live server', async () => {
    const server = createServer((_req, res) => res.end('INNER-SERVICE-DATA'));
    const port = await new Promise<number>((resolve) => server.listen(0, '::', () => resolve((server.address() as AddressInfo).port)));
    try {
      const out = await createWebFetchTool({ egress: publicEgress, limits }).run({ url: `http://[${globalV6}]:${port}/` }, { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock: () => new Date(), signal: never });
      expect(out).toMatchObject({ isError: true, content: expect.stringContaining('local network') });
    } finally {
      server.close();
    }
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

  it('lets a byte order mark win over the charset of the header', async () => {
    expect(await fetchFixture(site.url('shop.test', '/bom'))).toMatchObject({ ok: true, text: 'Café news' });
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

  it('skips readability on a page with more elements than the cap', () => {
    const page = extractReadable(`<html><body>${'<p>row</p>'.repeat(20_001)}<p>the end</p></body></html>`, 'https://x.example/');
    expect(page.method).toBe('page');
    expect(page.text).toContain('the end');
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

  it('strips tags in linear time, also with a run of "<", of "<title" or of white space that is not a new line', () => {
    for (const tail of ['<'.repeat(200_000), '<title'.repeat(100_000), '　'.repeat(200_000), '\v'.repeat(200_000)]) {
      const started = Date.now();
      expect(stripTags(`<p>hello</p>${tail}`).text).toMatch(/^hello/);
      expect(Date.now() - started, JSON.stringify(tail.slice(0, 6))).toBeLessThan(500);
    }
  });

  // the exit after a result ran the fallback on the main thread, so each extraction of such a page held the event loop.
  it('keeps the event loop free while and after the worker reads a hostile page', async () => {
    let gap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      gap = Math.max(gap, performance.now() - last);
      last = performance.now();
    }, 20);
    try {
      const page = await extractIsolated(`<p>hello</p>${'<'.repeat(100_000)}`, 'https://x.example/');
      expect(page.note).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      clearInterval(tick);
    }
    expect(gap).toBeLessThan(500);
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

  it('reads a page with no content type as html, so the model gets no script', async () => {
    const out = await tool.run({ url: site.url('shop.test', '/untyped') }, ctx);
    expect(out.content).toContain('Title: No type');
    expect(out.content).toContain('The page has no content type.');
    expect(out.content).not.toContain('var hidden');
  });

  it('says why a page was refused, also as untrusted text, because a redirect address comes from the server', async () => {
    const out = await tool.run({ url: site.url('shop.test', '/redir-private') }, ctx);
    expect(out).toMatchObject({ isError: true, untrustedSource: `web:shop.test:${site.port}` });
  });

  // web_fetch has no request log, so the stored output is the only record of each host that the pc asked.
  it('names each hop of a redirect, after a success and after a failure', async () => {
    const loop = site.url('shop.test', '/loop');
    const failed = await tool.run({ url: loop }, ctx);
    expect(failed.content).toBe(`web_fetch did not get ${loop}: more than 5 redirects\nRedirects: ${Array(5).fill(loop).join(' -> ')}`);
    const moved = await tool.run({ url: site.url('shop.test', '/redir-evil') }, ctx);
    expect(moved.content).toContain(`Redirects: ${site.url('evil.test', '/redirected?leak=1')}\n`);
  });
});
