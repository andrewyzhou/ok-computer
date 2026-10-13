import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserLogin } from '../src/browser/login.js';
import { profileBusy } from '../src/browser/worker.js';
import { createBrowserHarness, hasChrome, killChrome } from './browser-harness.js';
import { startFixture, type Fixture } from './web-fixture.js';

let site: Fixture;
beforeAll(async () => {
  site = await startFixture();
});
afterAll(() => site?.close());

type Harness = ReturnType<typeof createBrowserHarness>;
const open: Harness[] = [];
const harness = (...args: Parameters<typeof createBrowserHarness>) => {
  const made = createBrowserHarness(...args);
  open.push(made);
  return made;
};
afterEach(async () => {
  for (const each of open.splice(0)) await each.worker.stop();
});

const refOf = (text: string, pattern: RegExp) => {
  const line = text.split('\n').find((each) => pattern.test(each));
  const ref = line && /\[ref=([\w]+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`no ref for ${pattern} in:\n${text}`);
  return ref;
};

describe.skipIf(!hasChrome())('browser worker with chrome', { timeout: 60_000 }, () => {
  it('records a step with a snapshot and a screenshot, and starts the allowlist with the first site', async () => {
    const h = harness();
    const out = await h.run('browser_open', { url: site.url('shop.test') });
    expect(out.isError).toBe(false);
    expect(out.untrustedSource).toBe(`browser:shop.test:${site.port}`);
    expect(out.content).toMatch(/button "Buy now" \[ref=e\d+\]/);
    const [step] = h.steps();
    expect(step).toMatchObject({ action: 'open', urlAfter: site.url('shop.test') });
    expect(h.blobs.read(String(step!.snapshotBlob))).toContain('Buy now');
    const png = h.bytes.read(String(step!.screenshotBlob))!;
    expect(png.mime).toBe('image/png');
    expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(h.tasks()).toMatchObject([{ kind: 'task', status: 'open', allowlist: '["shop.test"]' }]);
    // the image of another host loads, and the frame of an off-list site does not.
    expect(site.hitsOn('cdn.test').length).toBeGreaterThan(0);
    expect(site.hitsOn('evil.test')).toEqual([]);
    expect(JSON.parse(String(step!.blockedRequests))).toEqual([expect.objectContaining({ url: site.url('evil.test', '/frame'), reason: expect.stringContaining('not on the allowlist') })]);
  });

  it.each([
    ['a link', /link "Evil link"/],
    ['a redirect of an allowed page', /link "Redirect link"/],
    ['a meta refresh', /link "Meta link"/],
    ['a script that sets the location', /button "Go"/],
    ['a link that opens a new tab', /link "Evil popup"/],
  ])('blocks and records %s to an off-list site', async (_name, pattern) => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test') });
    site.hits.length = 0;
    const out = await h.run('browser_click', { ref: refOf(first.content, pattern) });
    // the meta refresh runs after the click, so the next step sees it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await h.run('browser_snapshot', {});
    expect(site.hitsOn('evil.test')).toEqual([]);
    const blocked = [out.content, after.content].join('\n');
    expect(blocked).toMatch(/Blocked \d+ request/);
    expect(blocked).toContain('evil.test');
    const steps = h.steps().filter((step) => step.blockedRequests);
    expect(steps.length).toBeGreaterThan(1);
  });

  it('refuses a click on a button that sends a form, and blocks a form that a script sends', async () => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test') });
    const buy = await h.run('browser_click', { ref: refOf(first.content, /button "Buy now"/) });
    expect(buy).toMatchObject({ isError: true, content: expect.stringContaining('Use browser_submit') });
    const save = await h.run('browser_click', { ref: refOf(first.content, /button "Save"/) });
    expect(save.content).toContain('tried to send a form (POST)');
    expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/buy')).toEqual([]);
  });

  it('submits only when the page, the button and the fields are what the input says', async () => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test') });
    await h.run('browser_type', { ref: refOf(first.content, /textbox "Name"/), text: 'Ada' });
    const wrong = await h.run('browser_submit', { url: site.url('shop.test'), button: 'Buy now', fields: { name: 'Eve', size: 'S' } });
    expect(wrong).toMatchObject({ isError: true, content: expect.stringContaining('"name":"Ada"') });
    expect(wrong.effect).toBeUndefined();
    expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/buy')).toEqual([]);
    const sent = await h.run('browser_submit', { url: site.url('shop.test'), button: 'Buy now', fields: { name: 'Ada', size: 'S' } });
    expect(sent.isError).toBe(false);
    expect(sent.content).toContain('Order placed');
    expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/buy')).toEqual([expect.objectContaining({ method: 'POST', body: 'name=Ada&size=S&csrf=t0k3n' })]);
  });

  it('opens an off-list site only after browser_allow_domain', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test') });
    expect(await h.run('browser_open', { url: site.url('evil.test') })).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('browser_allow_domain') });
    await h.run('browser_allow_domain', { domain: 'evil.test', reason: 'test' });
    expect((await h.run('browser_open', { url: site.url('evil.test') })).isError).toBe(false);
    expect(site.hitsOn('evil.test').length).toBeGreaterThan(0);
  });

  it('saves a trace zip when the task ends', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test') });
    await h.run('browser_close', {});
    const [task] = h.tasks();
    expect(task).toMatchObject({ status: 'closed', tracePath: 'traces/task-1.zip' });
    expect(Number(task!.traceBytes)).toBeGreaterThan(1000);
    expect(existsSync(join(h.dir, 'traces', 'task-1.zip'))).toBe(true);
  });

  it('ends the task when chrome dies, and the next open starts chrome again', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test') });
    expect(killChrome(h.dir)).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(h.tasks()).toMatchObject([{ status: 'crashed', endReason: 'the browser stopped', traceError: expect.stringContaining('before the trace was saved') }]);
    const again = await h.run('browser_snapshot', {});
    expect(again).toMatchObject({ isError: true, effect: 'none' });
    expect((await h.run('browser_open', { url: site.url('shop.test') })).isError).toBe(false);
    expect(h.tasks().map((task) => task.status)).toEqual(['crashed', 'open']);
  });

  it('closes a hung tab, and the next open works', async () => {
    const h = harness();
    const out = await h.run('browser_open', { url: site.url('shop.test', '/hang') });
    // the loop starts after 100 ms, so the open itself can finish. the next step finds the page hung.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const hung = await h.run('browser_snapshot', {});
    expect([out.content, hung.content].join('\n')).toContain('stopped responding');
    expect(h.tasks()[0]).toMatchObject({ status: 'crashed', endReason: 'the page stopped responding' });
    expect((await h.run('browser_open', { url: site.url('shop.test') })).isError).toBe(false);
  });

  it('marks the open tasks of a crashed app as interrupted when chrome starts again', async () => {
    const h = harness();
    h.db.prepare("INSERT INTO browser_tasks (id, kind, sessionKey, allowlist, status, startedAt) VALUES ('old', 'task', 'main', '[]', 'open', 'x')").run();
    await h.run('browser_open', { url: site.url('shop.test') });
    expect(h.tasks().find((task) => task.id === 'old')).toMatchObject({ status: 'interrupted', traceError: expect.stringContaining('app stopped') });
  });

  it('says that the profile is in use when another chrome holds it', async () => {
    const first = harness();
    await first.run('browser_open', { url: site.url('shop.test') });
    expect(profileBusy(join(first.dir, 'profile'))).toBe(true);
    // two processes share one database file, so the second worker must not close the rows of the first.
    const second = harness({ dir: first.dir, db: first.db });
    const out = await second.run('browser_open', { url: site.url('shop.test') });
    expect(out).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('in use by another Chrome window') });
    // the second worker must not mark the live task of the first as interrupted.
    expect(first.tasks()[0]).toMatchObject({ status: 'open' });
  });

  it('refuses okc browser login while the agent holds the profile, and allows it after', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'okc-login-'));
    const h = harness({ dir: join(dataDir, 'browser') });
    await h.run('browser_open', { url: site.url('shop.test') });
    const launched: string[][] = [];
    const login = () => browserLogin({ dataDir, chrome: 'chrome.exe', launch: async (_chrome, args) => (launched.push(args), 0) });
    expect(await login()).toContain('profile is open now');
    expect(launched).toEqual([]);
    await h.worker.stop();
    expect(await login()).toContain('sign-ins are saved');
    expect(launched).toHaveLength(1);
  });

  it('refuses in a process that does not own the browser', async () => {
    const h = harness({ enabled: false });
    expect(await h.run('browser_open', { url: site.url('shop.test') })).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('background app') });
  });
});
