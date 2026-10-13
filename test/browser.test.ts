import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { browserLogin } from '../src/browser/login.js';
import { profileBusy } from '../src/browser/worker.js';
import { createBrowserHarness, hasChrome, killChrome, traceEntries } from './browser-harness.js';
import { FIXTURE_COOKIE, FIXTURE_PASSWORD, startFixture, type Fixture } from './web-fixture.js';

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
    expect(out.content).toMatch(/button "Buy now" \[ref=s1e\d+\]/);
    const [step] = h.steps();
    expect(step).toMatchObject({ action: 'open', urlAfter: site.url('shop.test') });
    expect(h.blobs.read(String(step!.snapshotBlob))).toContain('Buy now');
    const jpeg = h.bytes.read(String(step!.screenshotBlob))!;
    expect(jpeg.mime).toBe('image/jpeg');
    expect(jpeg.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
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

  it('goes back from the error page of chrome after a blocked link', async () => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test') });
    const out = await h.run('browser_click', { ref: refOf(first.content, /link "Evil link"/), element: 'Evil link' });
    expect(out.content).toContain(`Address: ${site.url('shop.test')}`);
    expect(out.content).toContain('the page stayed at');
    expect(out.content).toContain('button "Buy now"');
    expect(out.untrustedSource).toBe(`browser:shop.test:${site.port}`);
    const last = h.steps().at(-1)!;
    expect(last.urlAfter).toBe(site.url('shop.test'));
    expect(h.blobs.read(String(last.snapshotBlob))).toContain('Buy now');
    expect(JSON.stringify(h.steps())).not.toContain('chromewebdata');
  });

  it('sends the user agent of normal chrome', async () => {
    const h = harness();
    site.hits.length = 0;
    await h.run('browser_open', { url: site.url('shop.test', '/about') });
    const [hit] = site.hitsOn('shop.test');
    expect(hit!.agent).toMatch(/ Chrome\/\d+/);
    expect(hit!.agent).not.toContain('Headless');
  });

  it('refuses a click on a button that sends a form, and blocks a form that a script sends', async () => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test') });
    const buy = await h.run('browser_click', { ref: refOf(first.content, /button "Buy now"/) });
    expect(buy).toMatchObject({ isError: true, content: expect.stringContaining('Use browser_submit') });
    const save = await h.run('browser_click', { ref: refOf(buy.content, /button "Save"/) });
    expect(save.content).toContain('tried to send data (POST)');
    expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/buy')).toEqual([]);
  });

  it('sends no post from a script outside a submit: fetch, xhr and a beacon', async () => {
    const h = harness();
    let page = await h.run('browser_open', { url: site.url('shop.test', '/scripts') });
    for (const button of ['Fetch post', 'Xhr post', 'Beacon']) {
      const before = h.steps().length;
      await h.run('browser_click', { ref: refOf(page.content, new RegExp(`button "${button}"`)) });
      // the script sends after the click returns, so the next step sees the block too.
      await new Promise((resolve) => setTimeout(resolve, 300));
      page = await h.run('browser_snapshot', {});
      const blocked = h.steps().slice(before).flatMap((step) => (step.blockedRequests ? JSON.parse(String(step.blockedRequests)) : []));
      expect(blocked, button).toContainEqual({ url: site.url('shop.test', '/api/save'), reason: expect.stringContaining('send data (POST)') });
    }
    expect(site.hitsOn('shop.test').filter((hit) => hit.method !== 'GET')).toEqual([]);
  });

  it('lets a click send a get form, such as a search box', async () => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test', '/search') });
    const out = await h.run('browser_click', { ref: refOf(first.content, /button "Search"/) });
    expect(out.isError).toBe(false);
    expect(out.content).toContain('Found shirts');
    expect(site.hitsOn('shop.test').filter((hit) => hit.path.startsWith('/find'))).toEqual([expect.objectContaining({ method: 'GET', path: '/find?q=shirts' })]);
  });

  it('blocks a 307 hop of an approved post to an off-list host', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/pay') });
    const out = await h.run('browser_submit', { url: site.url('shop.test', '/pay'), button: 'Pay', fields: { amount: '5' } });
    expect(site.hitsOn('evil.test')).toEqual([]);
    expect(site.hitsOn('shop.test').filter((hit) => hit.method === 'POST')).toEqual([expect.objectContaining({ path: '/pay-go', body: 'amount=5' })]);
    expect(out.content).toContain(site.url('evil.test', '/steal'));
    const last = h.steps().at(-1)!;
    expect(JSON.parse(String(last.blockedRequests))).toContainEqual(expect.objectContaining({ url: site.url('evil.test', '/steal') }));
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
    // the step lists what the submit let out: one post, once, although both layers of the gate saw it.
    expect(JSON.parse(String(h.steps().at(-1)!.sent))).toEqual([{ method: 'POST', url: site.url('shop.test', '/buy') }]);
    expect(sent.content).toContain(`POST ${site.url('shop.test', '/buy')}`);
  });

  it('masks a password in every snapshot, and refuses to type or send one', async () => {
    const h = harness();
    const page = await h.run('browser_open', { url: site.url('shop.test', '/login') });
    expect(page.content).toMatch(/textbox "Password" \[ref=s1e\d+\]: ••••••/);
    const typed = await h.run('browser_type', { ref: refOf(page.content, /textbox "Password"/), element: 'password', text: 'other' });
    expect(typed).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('never types a password') });
    const sent = await h.run('browser_submit', { url: site.url('shop.test', '/login'), button: 'Sign in', fields: { user: 'ada', pw: '(password of 17 characters)' } });
    expect(sent).toMatchObject({ isError: true, content: expect.stringContaining('never sends a password') });
    const outputs = [page, typed, sent, await h.run('browser_snapshot', {})].map((each) => each.content).join('\n');
    expect(outputs).not.toContain(FIXTURE_PASSWORD);
    for (const step of h.steps()) expect(h.blobs.read(String(step.snapshotBlob))).not.toContain(FIXTURE_PASSWORD);
    expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/session')).toEqual([]);
    await h.run('browser_close', {});
    const trace = [...traceEntries(join(h.dir, 'traces', 'task-1.zip')).values()].map((bytes) => bytes.toString('latin1')).join('\n');
    expect(trace.length).toBeGreaterThan(1000);
    expect(trace).not.toContain(FIXTURE_PASSWORD);
  });

  it('refuses a ref of an older snapshot, and the page gets no click', async () => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test') });
    const about = refOf(first.content, /link "About"/);
    expect(about).toMatch(/^s1e\d+$/);
    const second = await h.run('browser_snapshot', {});
    expect(refOf(second.content, /link "About"/)).toBe(about.replace(/^s1/, 's2'));
    site.hits.length = 0;
    const out = await h.run('browser_click', { ref: about, element: 'About link' });
    expect(out).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('older snapshot') });
    expect(site.hitsOn('shop.test')).toEqual([]);
    expect(h.steps().at(-1)).toMatchObject({ action: 'click', urlAfter: site.url('shop.test') });
  });

  it('opens an off-list site only after browser_allow_domain', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test') });
    expect(await h.run('browser_open', { url: site.url('evil.test') })).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('browser_allow_domain') });
    // the owner approved a domain for the task of one page. the address must name the open task.
    expect(await h.run('browser_allow_domain', { url: site.url('cdn.test'), domain: 'evil.test', reason: 'test' })).toMatchObject({ isError: true, content: expect.stringContaining('was not added') });
    await h.run('browser_allow_domain', { url: site.url('shop.test'), domain: 'evil.test', reason: 'test' });
    expect((await h.run('browser_open', { url: site.url('evil.test') })).isError).toBe(false);
    expect(site.hitsOn('evil.test').length).toBeGreaterThan(0);
  });

  it('keeps the task of a session from another session, also when it is idle for more than a minute', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test') }, 'main');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    try {
      expect(await h.run('browser_open', { url: site.url('shop.test', '/about') }, 'auto:a:r')).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('busy') });
    } finally {
      clock.mockRestore();
    }
    expect(h.tasks()).toMatchObject([{ sessionKey: 'main', status: 'open' }]);
  });

  it('sends the form of a page that a child session opened, from the parent, only for the page in the input', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test') }, 'sub:browser:x');
    const before = site.hitsOn('shop.test').filter((hit) => hit.path === '/buy').length;
    const wrong = await h.run('browser_submit', { url: site.url('shop.test', '/about'), button: 'Buy now', fields: { name: '', size: 'S' } }, 'main');
    expect(wrong).toMatchObject({ isError: true, content: expect.stringContaining('Nothing was sent') });
    const sent = await h.run('browser_submit', { url: site.url('shop.test'), button: 'Buy now', fields: { name: '', size: 'S' } }, 'main');
    expect(sent.isError).toBe(false);
    expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/buy').length - before).toBe(1);
    // the other tools of main still act only on a task of main.
    expect(await h.run('browser_snapshot', {}, 'main')).toMatchObject({ isError: true, content: expect.stringContaining('in this session') });
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

  it('keeps no cookie, header, network log or dom in the trace, and keeps the screenshots and the actions', async () => {
    const h = harness();
    const first = await h.run('browser_open', { url: site.url('shop.test') });
    await h.run('browser_type', { ref: refOf(first.content, /textbox "Name"/), element: 'name', text: 'Ada' });
    await h.run('browser_open', { url: site.url('shop.test', '/about') });
    await h.run('browser_close', {});
    const entries = traceEntries(join(h.dir, 'traces', 'task-1.zip'));
    const names = [...entries.keys()];
    const text = [...entries.values()].map((bytes) => bytes.toString('latin1')).join('\n');
    expect(text).not.toMatch(/set-cookie|"cookie"/i);
    expect(text).not.toContain(FIXTURE_COOKIE.split('=')[1]);
    expect(names.filter((name) => name.endsWith('.network'))).toEqual(names.filter((name) => name.endsWith('.network') && entries.get(name)!.length === 0));
    expect(text).not.toContain('"frame-snapshot"');
    // the screenshots are jpeg resources, and the action list names the steps.
    expect(names.filter((name) => name.startsWith('resources/')).every((name) => entries.get(name)!.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])))).toBe(true);
    expect(text).toContain('screencast-frame');
    expect(text).toMatch(/"method":"goto"/);
    // the fill keeps what the agent typed. the tool_calls row of browser_type already stores the same text, redacted.
    expect(text).toMatch(/"method":"fill"[^\n]*"value":"Ada"/);
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
