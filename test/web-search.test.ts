import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetting } from '../src/db/settings.js';
import type { BrowserWorker } from '../src/browser/worker.js';
import { openDb } from '../src/db/index.js';
import { createWebSearchTool, resumeEngines, type Engine } from '../src/web/search.js';
import { createBrowserHarness, hasChrome, traceEntries } from './browser-harness.js';
import { startFixture, type Fixture } from './web-fixture.js';

let site: Fixture;
beforeAll(async () => {
  site = await startFixture();
});
afterAll(() => site?.close());

let h: ReturnType<typeof createBrowserHarness> | undefined;
afterEach(async () => {
  await h?.worker.stop();
  h = undefined;
  site.google = 'ok';
});

function setup() {
  h = createBrowserHarness();
  let now = new Date('2026-10-13T17:00:00Z');
  const engines: Engine[] = [
    { id: 'google', label: 'Google', hosts: ['google.test'], url: (q) => site.url('www.google.test', `/search?q=${encodeURIComponent(q)}`) },
    { id: 'duckduckgo', label: 'DuckDuckGo', hosts: ['duckduckgo.test'], url: (q) => site.url('html.duckduckgo.test', `/html/?q=${encodeURIComponent(q)}`) },
  ];
  const waits: number[] = [];
  const make = () =>
    createWebSearchTool({ db: h!.db, worker: h!.worker, clock: () => now, timeZone: 'UTC', engines, sleep: async (ms) => void waits.push(ms) });
  const tool = make();
  const ctx = { runId: 'run-1', sessionKey: 'main', timeZone: 'UTC', clock: () => now, signal: new AbortController().signal, toolCallId: 'c1' };
  return {
    h: h!,
    waits,
    search: (query: string, which = tool) => which.run({ query }, ctx),
    make,
    later: (ms: number) => (now = new Date(now.getTime() + ms)),
    state: () => getSetting<Record<string, { strikes: number; until?: string }>>(h!.db, 'web_search.engines') ?? {},
  };
}

describe.skipIf(!hasChrome())('web_search through the browser', { timeout: 60_000 }, () => {
  it('reads the results of google, and records the search as a step with a screenshot', async () => {
    const s = setup();
    const out = await s.search('autumn shirts');
    expect(out.untrustedSource).toBe('web_search:google');
    expect(out.content).toContain('1. Autumn shirts for autumn shirts\n   https://shirts.example/autumn');
    expect(out.content).toContain('https://wiki.example/Shirt');
    expect(s.h.tasks()).toMatchObject([{ kind: 'search', status: 'closed' }]);
    expect(s.h.steps()).toMatchObject([{ action: 'search', target: JSON.stringify('google: autumn shirts'), screenshotBlob: expect.any(String) }]);
  });

  // a search during an open task goes into the trace of the task: the screencast shows the search page, and each
  // console message keeps its address (r5 probes). so a query with a secret is refused before any page opens.
  it('searches for no secret, so none reaches the trace of a task that is open at the same time', async () => {
    const s = setup();
    await s.h.run('browser_open', { url: site.url('shop.test', '/about') });
    const hits = site.hits.length;
    // not a real secret: a value with the shape of an api key.
    const out = await s.search('what is sk-ant-api03-PROBESECRETvalue0123456789');
    expect(out).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('the shape of a secret') });
    expect(site.hits.length).toBe(hits);
    await s.h.run('browser_close', {});
    const trace = [...traceEntries(join(s.h.dir, 'traces', 'task-1.zip')).values()].map((bytes) => bytes.toString('latin1')).join('\n');
    expect(trace).toContain('/about');
    expect(trace).not.toContain('PROBESECRET');
    expect(s.h.tasks().map((task) => task.kind)).toEqual(['task']);
  });

  // the results show the query, as real engines do, so the text of a captcha page paused both engines (r5 probe).
  it('reads results about an unusual traffic message as results, not as a captcha', async () => {
    const s = setup();
    const out = await s.search('bank says unusual activity and unusual traffic, is it a scam');
    expect(out.untrustedSource).toBe('web_search:google');
    expect(out.content).toContain('Autumn shirts for bank says unusual activity');
    expect(s.state()).toEqual({});
    // google finds nothing, so duckduckgo reads the same words.
    site.google = 'layout';
    s.later(60_000);
    const ddg = await s.search('bank says unusual activity and unusual traffic');
    expect(ddg.untrustedSource).toBe('web_search:duckduckgo');
    expect(s.state()).toEqual({});
  });

  it('falls back to duckduckgo after a captcha, and the pause survives a restart', async () => {
    const s = setup();
    site.google = 'captcha';
    const out = await s.search('shirts');
    expect(out.untrustedSource).toBe('web_search:duckduckgo');
    expect(out.content).toContain('https://shirts.example/ddg');
    expect(out.content).toContain('Google showed a CAPTCHA, so it pauses until 17:15');
    expect(s.state().google).toMatchObject({ strikes: 1, until: '2026-10-13T17:15:00.000Z' });

    site.google = 'ok';
    const googleHits = site.hitsOn('www.google.test').length;
    const restarted = s.make();
    const again = await s.search('shirts', restarted);
    expect(again.content).toContain('Google is paused until 17:15 (a CAPTCHA)');
    expect(site.hitsOn('www.google.test').length).toBe(googleHits);

    // a second captcha after the pause waits longer.
    s.later(16 * 60_000);
    site.google = 'captcha';
    await s.search('shirts');
    expect(s.state().google).toMatchObject({ strikes: 2, until: '2026-10-13T18:16:00.000Z' });

    // a success clears the strikes.
    s.later(61 * 60_000);
    site.google = 'ok';
    expect((await s.search('shirts')).untrustedSource).toBe('web_search:google');
    expect(s.state().google).toEqual({ strikes: 0 });
  });

  it('treats a consent page as a wall, not as a result', async () => {
    const s = setup();
    site.google = 'consent';
    const out = await s.search('shirts');
    expect(out.untrustedSource).toBe('web_search:duckduckgo');
    expect(out.content).toContain('Google showed a consent page');
    expect(s.state().google).toMatchObject({ until: '2026-10-13T18:00:00.000Z' });
  });

  it('tries the next engine when the reader finds no result, for example after a layout change', async () => {
    const s = setup();
    site.google = 'layout';
    const out = await s.search('shirts');
    expect(out.untrustedSource).toBe('web_search:duckduckgo');
    expect(out.content).toContain('Google gave no result that the reader found');
  });

  it('tries the next engine when a results page hangs, and the next search does not wait for it', async () => {
    const s = setup();
    site.google = 'hang';
    const out = await s.search('shirts');
    expect(out.untrustedSource).toBe('web_search:duckduckgo');
    expect(out.content).toContain('Google did not load: the page gave no answer within');
    expect(s.h.tasks().map((task) => task.status)).toEqual(['crashed', 'closed']);
    site.google = 'ok';
    expect((await s.search('shirts')).untrustedSource).toBe('web_search:google');
  });

  it('keeps a gap between two searches of one engine', async () => {
    const s = setup();
    await Promise.all([s.search('one'), s.search('two')]);
    expect(s.waits.length).toBe(1);
    expect(s.waits[0]).toBeGreaterThan(0);
  });
});

// the gap and the hourly count used the wall clock. after it went back one hour, the next search slept one hour, and
// every later search of the app waited behind it.
describe('web_search timing', () => {
  afterEach(() => vi.useRealTimers());

  it('waits at most the gap after the wall clock goes back, and never before the first search', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T18:00:00Z'));
    const worker = {
      inTab: async () => ({
        value: { kind: 'results', results: [{ title: 'A', url: 'https://a.example/', snippet: 'a' }] },
        result: { ok: true, note: '', url: '', title: '', blocked: [], blockedMore: 0, sent: [], taskId: 't', acted: true },
      }),
    } as unknown as BrowserWorker;
    const waits: number[] = [];
    const tool = createWebSearchTool({ db: openDb(':memory:'), worker, clock: () => new Date(), timeZone: 'UTC', sleep: async (ms) => void waits.push(ms) });
    const ctx = { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock: () => new Date(), signal: new AbortController().signal, toolCallId: 'c' };
    expect((await tool.run({ query: 'one' }, ctx)).content).toContain('Results from Google');
    expect(waits).toEqual([]);
    vi.setSystemTime(new Date('2026-10-13T17:00:00Z'));
    expect((await tool.run({ query: 'two' }, ctx)).content).toContain('Results from Google');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(2_000);
  });
});

// a fake worker: google answers with a captcha or with results, and a block can come with the answer.
function fakeSearch(start: string) {
  const db = openDb(':memory:');
  let now = new Date(start);
  const page = { google: 'captcha' as 'captcha' | 'results', blocked: [] as Array<{ url: string; reason: string; top?: boolean }> };
  const worker = {
    async inTab(_step: unknown, hosts: string[]) {
      const google = hosts[0] === 'google.com';
      const value = google && page.google === 'captcha' ? { kind: 'captcha' } : { kind: 'results', results: [{ title: google ? 'G' : 'D', url: 'https://x.example/', snippet: '' }] };
      return { value, result: { ok: true, note: '', url: '', title: '', blocked: google ? page.blocked : [], blockedMore: 0, sent: [], taskId: 't', acted: true } };
    },
  } as unknown as BrowserWorker;
  const tool = createWebSearchTool({ db, worker, clock: () => now, timeZone: 'UTC', sleep: async () => undefined });
  const ctx = { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock: () => now, signal: new AbortController().signal, toolCallId: 'c' };
  return { db, page, search: () => tool.run({ query: 'q' }, ctx), set: (at: string) => (now = new Date(at)) };
}

describe('web_search pauses', () => {
  it('reads a consent wall only from a block of the search page itself', async () => {
    const s = fakeSearch('2026-10-13T17:00:00Z');
    s.page.google = 'results';
    // the proxy puts the refusals of another task into the search tab too.
    s.page.blocked = [{ url: 'http://consent.tracker.example/s', reason: 'refused' }];
    expect((await s.search()).untrustedSource).toBe('web_search:google');
    s.page.blocked = [{ url: 'https://evil.example/?consent.google.de', reason: 'refused', top: true }];
    expect((await s.search()).untrustedSource).toBe('web_search:google');
    s.page.blocked = [{ url: 'https://consent.google.de/ml', reason: 'not on the allowlist', top: true }];
    const walled = await s.search();
    expect(walled.content).toContain('Google showed a consent page');
    expect(walled.untrustedSource).toBe('web_search:duckduckgo');
  });

  it('ends the pause when okc browser login closes, and keeps the strikes', async () => {
    const s = fakeSearch('2026-10-13T17:00:00Z');
    expect((await s.search()).content).toContain('Google showed a CAPTCHA, so it pauses until 17:15');
    s.page.google = 'results';
    s.set('2026-10-13T17:02:00Z');
    expect((await s.search()).content).toContain('Google is paused until 17:15 (a CAPTCHA)');
    resumeEngines(s.db, new Date());
    expect((await s.search()).untrustedSource).toBe('web_search:google');
    // a success clears the strikes. without it, the next captcha waits an hour.
    resumeEngines(s.db, new Date());
    s.page.google = 'captcha';
    expect((await s.search()).content).toContain('pauses until 17:17');
  });

  it('ends a pause that began while the wall clock was ahead, and names the date of a pause that ends on another day', async () => {
    const s = fakeSearch('2026-11-12T17:00:00Z');
    await s.search();
    s.set('2026-10-13T18:00:00Z');
    s.page.google = 'results';
    expect((await s.search()).untrustedSource).toBe('web_search:google');
    // four captchas: the fourth pause is a day.
    s.page.google = 'captcha';
    for (const at of ['2026-10-13T19:00:00Z', '2026-10-13T19:20:00Z', '2026-10-13T20:30:00Z']) {
      s.set(at);
      await s.search();
    }
    s.set('2026-10-14T03:00:00Z');
    expect((await s.search()).content).toContain('pauses until 2026-10-15 03:00');
  });
});
