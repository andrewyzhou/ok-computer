import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserHarness, hasChrome } from './browser-harness.js';

// the idle close of chrome runs on a timer. these tests slow one playwright call, so a tick of the timer lands inside a
// tab that starts or ends, as it can in the app.

let port = 0;
const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>p</title><h1>plain</h1>'));
beforeAll(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => ((port = (server.address() as { port: number }).port), resolve()))));
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const within = <T>(work: Promise<T>, ms: number) => Promise.race([work, sleep(ms).then(() => 'HUNG' as const)]);
const IDLE_MS = 500;

type Harness = ReturnType<typeof createBrowserHarness>;
const restore: Array<() => void> = [];
const open: Harness[] = [];
afterEach(async () => {
  for (const undo of restore.splice(0)) undo();
  for (const each of open.splice(0)) await within(each.worker.stop(), 20_000);
});

// the patch is on the class of playwright, so it reaches the next context too. the test removes it after.
async function slow(h: Harness, target: 'context' | 'page', method: string, ms: () => number): Promise<void> {
  await h.worker.act({ sessionKey: 'main', runId: 'run-1', action: 'patch' }, async (page) => {
    const proto = Object.getPrototypeOf(target === 'page' ? page : page.context()) as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = proto[method]!;
    proto[method] = async function (this: unknown, ...args: unknown[]) {
      await sleep(ms());
      return original.apply(this, args);
    };
    restore.push(() => (proto[method] = original));
  });
}

describe.skipIf(!hasChrome())('the idle close of chrome', { timeout: 60_000 }, () => {
  const url = () => `http://shop.test:${port}/`;

  it('waits for a tab that starts, so the open returns and later opens work', async () => {
    const h = createBrowserHarness({ idleMs: IDLE_MS });
    open.push(h);
    await h.run('browser_open', { url: url() });
    await slow(h, 'context', 'newPage', () => 3 * IDLE_MS);
    await h.run('browser_close', {});
    const first = await within(h.run('browser_open', { url: url() }, 'other'), 20_000);
    expect(first === 'HUNG' ? 'HUNG' : first.isError ? first.content : 'ok').toBe('ok');
    const later = await within(h.run('browser_open', { url: url() }, 'later'), 20_000);
    expect(later === 'HUNG' ? 'HUNG' : 'returned').toBe('returned');
  });

  it('waits for a tab that ends, so the task keeps its trace and later tasks get theirs', async () => {
    const h = createBrowserHarness({ idleMs: IDLE_MS });
    open.push(h);
    await h.run('browser_open', { url: url() });
    let delay = 3 * IDLE_MS;
    await slow(h, 'page', 'close', () => delay);
    // the task ends after idleMs without an action, and its page close spans several ticks.
    await sleep(5 * IDLE_MS);
    delay = 0;
    for (const session of ['later0', 'later1']) {
      await h.run('browser_open', { url: url() }, session);
      await h.run('browser_close', {}, session);
    }
    expect(h.tasks().map((row) => [row.id, row.status, Boolean(row.tracePath)])).toEqual([
      ['task-1', 'closed', true],
      ['task-2', 'closed', true],
      ['task-3', 'closed', true],
    ]);
  });

  it('waits for its own chrome to end before it starts chrome again, and does not blame another window', async () => {
    const h = createBrowserHarness({ idleMs: IDLE_MS });
    open.push(h);
    await h.run('browser_open', { url: url() });
    await slow(h, 'context', 'close', () => 4 * IDLE_MS);
    await h.run('browser_close', {});
    // the idle close starts within two ticks, and chrome still runs for a while after it.
    await sleep(3 * IDLE_MS);
    const out = await h.run('browser_open', { url: url() }, 'other');
    expect(out.isError ? out.content : 'ok').toBe('ok');
  });
});
