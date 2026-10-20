import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_RETRY, createBrowserHarness, hasChrome } from './browser-harness.js';

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
// a stop closes chrome and saves the trace. on a busy machine that takes longer than the 10 s of a hook.
afterEach(async () => {
  for (const undo of restore.splice(0)) undo();
  for (const each of open.splice(0)) await within(each.worker.stop(), 20_000);
}, 60_000);

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

describe.skipIf(!hasChrome())('the idle close of chrome', { timeout: 60_000, retry: CHROME_RETRY }, () => {
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

  it('waits for a slow trace stop of the last task before the limit of a new tab starts', async () => {
    // the trace stop and the start of a tab share the navigation limit, 9 s here. the page close and the trace stop
    // together take longer than it, and the stop alone stays 3 s under it, so a slow disk that writes the trace on a
    // windows runner does not use up the margin.
    const h = createBrowserHarness({ idleMs: IDLE_MS, timeouts: { action: 3000, navigation: 9000, capture: 2000 } });
    open.push(h);
    await h.run('browser_open', { url: url() });
    let delay = 4_000;
    await slow(h, 'page', 'close', () => delay);
    // the trace stop of the first task is slow, as on a busy windows machine.
    await h.worker.act({ sessionKey: 'main', runId: 'run-1', action: 'patch' }, async (page) => {
      const proto = Object.getPrototypeOf(page.context().tracing) as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = proto.stop!;
      let first = true;
      proto.stop = async function (this: unknown, ...args: unknown[]) {
        if (first) await sleep(6_000);
        first = false;
        return original.apply(this, args);
      };
      restore.push(() => (proto.stop = original));
    });
    // the next task opens while the first one still ends.
    await sleep(3 * IDLE_MS);
    delay = 0;
    for (const session of ['later0', 'later1']) {
      const out = await h.run('browser_open', { url: url() }, session);
      expect(out.isError ? out.content : 'ok').toBe('ok');
      await h.run('browser_close', {}, session);
    }
    expect(h.tasks().map((row) => [row.id, row.status, Boolean(row.tracePath)])).toEqual([
      ['task-1', 'closed', true],
      ['task-2', 'closed', true],
      ['task-3', 'closed', true],
    ]);
  });

  it('keeps a task open while a submit for it waits for the owner, and ends it when the approval is gone', async () => {
    const h = createBrowserHarness({ idleMs: IDLE_MS });
    open.push(h);
    // an approval of an earlier task does not hold the new task.
    h.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('run-1', 'main', 'message', 'main', 'running', ?)").run(new Date().toISOString());
    const ask = (at: string) =>
      Number(h.db.prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES ('run-1', 'browser_submit', '{}', 's', 'pending', ?) RETURNING id").get(at)!.id);
    ask('2026-01-01T00:00:00.000Z');
    await h.run('browser_open', { url: url() });
    const id = ask(new Date().toISOString());
    await sleep(5 * IDLE_MS);
    expect(h.tasks().map((row) => row.status)).toEqual(['open']);
    // an approved call that did not start yet still holds the task.
    h.db.prepare("UPDATE approvals SET status = 'approved' WHERE id = ?").run(id);
    await sleep(3 * IDLE_MS);
    expect(h.tasks().map((row) => row.status)).toEqual(['open']);
    h.db.prepare("UPDATE approvals SET status = 'denied' WHERE id = ?").run(id);
    // the close saves the trace, which takes longer when the full suite runs.
    for (let waited = 0; h.tasks()[0]!.status === 'open' && waited < 20_000; waited += IDLE_MS) await sleep(IDLE_MS);
    expect(h.tasks().map((row) => row.status)).toEqual(['closed']);
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
