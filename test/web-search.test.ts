import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSetting } from '../src/db/settings.js';
import { createWebSearchTool, type Engine } from '../src/web/search.js';
import { createBrowserHarness, hasChrome } from './browser-harness.js';
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

  it('keeps a gap between two searches of one engine', async () => {
    const s = setup();
    await Promise.all([s.search('one'), s.search('two')]);
    expect(s.waits.length).toBe(1);
    expect(s.waits[0]).toBeGreaterThan(0);
  });
});
