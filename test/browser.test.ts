import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSocket } from 'node:dgram';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { siteOf } from '../src/browser/gate.js';
import { browserLogin } from '../src/browser/login.js';
import { maskPasswords, profileBusy } from '../src/browser/worker.js';
import { openDb } from '../src/db/index.js';
import { registerSecret } from '../src/observability/redact.js';
import { createBrowserHarness, hasChrome, killChrome, traceEntries } from './browser-harness.js';
import { FIXTURE_COOKIE, FIXTURE_PASSWORD, startFixture, type Fixture } from './web-fixture.js';

// not real secrets: a value with the shape of an api key, and a value that the test registers.
const PATTERN_KEY = 'sk-ant-api03-PROBESECRETvalue0123456789';
const REGISTERED = 'REGISTERED-SECRET-VALUE-42';

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

describe('the password mask', () => {
  it('masks the longest value whole, and masks 3,000 long values in one pass', () => {
    expect(maskPasswords('- textbox: abcdef and abc', ['abc', 'abcdef'])).toBe('- textbox: •••••• and ••••••');
    expect(maskPasswords('a.b+c and axb+c', ['a.b+c'])).toBe('•••••• and axb+c');
    // each form of each value went through the whole snapshot once, and this page held the event loop for 246 s.
    const values = Array.from({ length: 3000 }, (_, i) => String(i).padStart(8, '0') + 'p'.repeat(592));
    const snapshot = values.map((value, i) => `- textbox [ref=e${i + 3}]: ${value}`).join('\n');
    const started = performance.now();
    const masked = maskPasswords(snapshot, values.slice(0, 200));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(masked.match(/p{592}/g)).toHaveLength(2800);
    expect(() => maskPasswords(snapshot, values)).toThrow('more than 200');
  });
});

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
    // chrome's own connections, for example to google.com, also go through the proxy, and the fixture egress refuses them.
    const ofPages = (JSON.parse(String(step!.blockedRequests)) as Array<{ url: string }>).filter((each) => /\.test[:/]/.test(each.url));
    expect(ofPages).toEqual([expect.objectContaining({ url: site.url('evil.test', '/frame'), reason: expect.stringContaining('not on the allowlist') })]);
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
    expect(out.content).toContain(`the tab went back to ${site.url('shop.test')}`);
    expect(out.content).toContain('button "Buy now"');
    expect(out.untrustedSource).toBe(`browser:shop.test:${site.port}`);
    const last = h.steps().at(-1)!;
    expect(last.urlAfter).toBe(site.url('shop.test'));
    expect(h.blobs.read(String(last.snapshotBlob))).toContain('Buy now');
    expect(JSON.stringify(h.steps())).not.toContain('chromewebdata');
  });

  it('goes back from the error page of chrome after a block between two steps', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/late-evil') });
    // the refresh comes 1 s after the load, when no step runs.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const out = await h.run('browser_snapshot', {});
    expect(out.content).toContain('the tab went back to');
    expect(out.content).not.toContain('chrome-error');
    expect(out.untrustedSource).toBe(`browser:shop.test:${site.port}`);
    expect(site.hitsOn('evil.test')).toEqual([]);
    // the block came when no step ran, so the next step records it.
    expect(out.content).toContain(site.url('evil.test', '/late?leak=1'));
    expect(JSON.parse(String(h.steps().at(-1)!.blockedRequests))).toContainEqual(expect.objectContaining({ url: site.url('evil.test', '/late?leak=1') }));
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

  it('saves no download', async () => {
    const h = harness();
    const page = await h.run('browser_open', { url: site.url('shop.test', '/files') });
    await h.run('browser_click', { ref: refOf(page.content, /link "Invoice"/), element: 'Invoice link' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const downloads = join(h.dir, 'downloads');
    expect(existsSync(downloads) ? readdirSync(downloads) : []).toEqual([]);
  });

  it('opens a web socket only to the allowlist, and records the hosts that a page script reached with typed text', async () => {
    const h = harness();
    site.hits.length = 0;
    const page = await h.run('browser_open', { url: site.url('shop.test', '/typed') });
    expect(site.hitsOn('shop.test').filter((hit) => hit.method === 'UPGRADE')).toMatchObject([{ path: '/ws-own' }]);
    await h.run('browser_type', { ref: refOf(page.content, /textbox "Address"/), element: 'Address', text: 'HOME-42' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await h.run('browser_snapshot', {});
    expect(site.hitsOn('evil.test').filter((hit) => hit.method === 'UPGRADE')).toEqual([]);
    const all = (column: string) => h.steps().flatMap((step) => (step[column] ? (JSON.parse(String(step[column])) as unknown[]) : []));
    expect(all('blockedRequests')).toContainEqual(expect.objectContaining({ url: expect.stringMatching(/^ws:\/\/evil\.test:\d+\/ws\?v=HOME-42$/) }));
    // an image is a get, which the gate lets out. the steps record where it went.
    expect(site.hitsOn('evil.test').map((hit) => hit.path)).toContain('/img?v=HOME-42');
    expect(all('offsiteHosts')).toContain('evil.test');
    expect(all('offsiteHosts')).not.toContain('shop.test');
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
    site.hits.length = 0;
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
    expect(JSON.parse(String(h.steps().at(-1)!.sent))).toEqual([{ method: 'POST', url: site.url('shop.test', '/buy'), body: 'name=Ada&size=S&csrf=t0k3n' }]);
    expect(sent.content).toContain(`POST ${site.url('shop.test', '/buy')}`);
  });

  it('sends the form whose button it checked, and names a button as the snapshot does', async () => {
    const h = harness();
    const page = await h.run('browser_open', { url: site.url('shop.test', '/forms') });
    // the snapshot names the donate button "Buy now", and the hidden "Buy now" of the other form is not in it.
    expect(page.content).toMatch(/button "Buy now"/);
    expect(page.content).toMatch(/button "Send message"/);
    site.hits.length = 0;
    const posts = () => site.hitsOn('shop.test').filter((hit) => hit.method === 'POST');
    // the fields of the order form, with the name of the donate button: the check reads the donate form, so it refuses.
    const mixed = await h.run('browser_submit', { url: site.url('shop.test', '/forms'), button: 'Buy now', fields: { note: 'hello' } });
    expect(mixed).toMatchObject({ isError: true, content: expect.stringContaining('the form now has these fields: {}') });
    // the text of a button is not its name.
    const text = await h.run('browser_submit', { url: site.url('shop.test', '/forms'), button: 'Send', fields: { msg: 'hi' } });
    expect(text).toMatchObject({ isError: true, content: expect.stringContaining('no button is named "Send"') });
    expect(posts()).toEqual([]);
    const sent = await h.run('browser_submit', { url: site.url('shop.test', '/forms'), button: 'Send message', fields: { msg: 'hi' } });
    expect(sent.isError).toBe(false);
    expect(sent.content).toContain('Message sent');
    expect(posts()).toEqual([expect.objectContaining({ path: '/send', body: 'msg=hi' })]);
  });

  // the gate let data out only while the click ran, and the tool said "sent" also when the page sent nothing.
  it.each([
    ['a script post at the click', 'sync', '/api/order'],
    ['a script post after a wait', 'await', '/api/order'],
    ['a submit of the page after a wait', 'delayed', '/order'],
  ])('sends a form that the page sends with %s', async (_name, mode, target) => {
    const h = harness();
    const url = site.url('shop.test', `/script-form?mode=${mode}`);
    await h.run('browser_open', { url });
    site.hits.length = 0;
    const out = await h.run('browser_submit', { url, button: 'Place order', fields: { qty: '1' } });
    expect(out.isError).toBe(false);
    expect(site.hitsOn('shop.test').filter((hit) => hit.method === 'POST').map((hit) => hit.path)).toEqual([target]);
    expect(out.content).toContain(`POST ${site.url('shop.test', target)}`);
  });

  it('says that nothing was sent when the page sends nothing, and sends no data off the allowlist at the click', async () => {
    const h = harness();
    for (const mode of ['blank', 'offsite']) {
      const url = site.url('shop.test', `/script-form?mode=${mode}`);
      await h.run('browser_open', { url });
      site.hits.length = 0;
      const out = await h.run('browser_submit', { url, button: 'Place order', fields: { qty: '1' } });
      expect(out, mode).toMatchObject({ isError: true, content: expect.stringContaining('the page sent no data within 5 s, so the form was not sent') });
      expect(out.content, mode).not.toContain("with the owner's approval");
      expect(site.hits.filter((hit) => hit.method === 'POST'), mode).toEqual([]);
    }
    expect(JSON.parse(String(h.steps().at(-1)!.blockedRequests))).toContainEqual(expect.objectContaining({ url: site.url('evil.test', '/exfil'), reason: expect.stringContaining('may not send data to it') }));
  });

  // the check read a map of the controls, so a name sent twice showed one value, a multiple select showed one option,
  // and a disabled field showed a value that was never sent.
  it('checks the fields as the browser sends them: each value of a name, each selected option, no disabled field', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/tricky') });
    site.hits.length = 0;
    const url = site.url('shop.test', '/tricky');
    const dup = await h.run('browser_submit', { url, button: 'Send dup', fields: { to: 'alice@example.com' } });
    expect(dup).toMatchObject({ isError: true, content: expect.stringContaining('"to":["mallory@evil.example","alice@example.com"]') });
    const multi = await h.run('browser_submit', { url, button: 'Send multi', fields: { with: 'alice' } });
    expect(multi).toMatchObject({ isError: true, content: expect.stringContaining('"with":["alice","mallory"]') });
    const disabled = await h.run('browser_submit', { url, button: 'Send disabled', fields: { amount: '5' } });
    expect(disabled).toMatchObject({ isError: true, content: expect.stringContaining('the form now has these fields: {}') });
    expect(site.hitsOn('shop.test').filter((hit) => hit.method === 'POST')).toEqual([]);
    const sent = await h.run('browser_submit', { url, button: 'Send dup', fields: { to: ['alice@example.com', 'mallory@evil.example'] } });
    expect(sent.isError).toBe(false);
    expect(site.hitsOn('shop.test').filter((hit) => hit.method === 'POST')).toEqual([expect.objectContaining({ body: 'to=mallory%40evil.example&to=alice%40example.com' })]);
    // the other two encodings of a form also match the check, also with a new line in a value and an empty file field.
    for (const [button, fields] of [
      ['Send multipart', { note: 'line one\nline two', doc: '' }],
      ['Send plain', { words: 'a=b c' }],
    ] as const) {
      const out = await h.run('browser_open', { url });
      expect(out.isError).toBe(false);
      expect(await h.run('browser_submit', { url, button, fields })).toMatchObject({ isError: false, content: expect.stringContaining('Order placed') });
    }
    expect(site.hitsOn('shop.test').filter((hit) => hit.method === 'POST')).toHaveLength(3);
  });

  it.each([
    ['Buy on pointer', 'book'],
    ['Buy on submit', 'pen'],
  ])('sends nothing when the page changes a field at the click (%s)', async (button, item) => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/tricky') });
    site.hits.length = 0;
    const out = await h.run('browser_submit', { url: site.url('shop.test', '/tricky'), button, fields: { item, amount: '1' } });
    expect(site.hitsOn('shop.test').filter((hit) => hit.method === 'POST')).toEqual([]);
    expect(out.content).toContain('the page changed the form after the check');
    expect(JSON.parse(String(h.steps().at(-1)!.blockedRequests))).toContainEqual(expect.objectContaining({ url: site.url('shop.test', '/buy') }));
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

  it('masks a password in a frame too', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/pw-frame') });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const out = await h.run('browser_snapshot', {});
    expect(out.content).toMatch(/textbox "Frame pw" \[ref=s2f\d+e\d+\]: ••••••/);
    for (const text of [out.content, ...h.steps().map((step) => h.blobs.read(String(step.snapshotBlob)))]) expect(text).not.toContain(FIXTURE_PASSWORD);
  });

  // the snapshot trims a value, shows a tab or a line separator as a space, and escapes a value in quotes.
  it('masks a password whose white space or quotes the snapshot changes', async () => {
    const h = harness();
    const out = await h.run('browser_open', { url: site.url('shop.test', '/pw-space') });
    for (const i of [0, 1, 2, 3]) expect(out.content).toMatch(new RegExp(`textbox "P${i}" \\[ref=s1e\\d+\\]: "?••••••"?$`, 'm'));
    for (const text of [out.content, h.blobs.read(String(h.steps()[0]!.snapshotBlob))]) expect(text).not.toContain(FIXTURE_PASSWORD);
  });

  // pagehide, unload and visibilitychange run when the tab closes, after the page layers of the gate stopped.
  it.each(['browser_close', 'the idle close', 'the app stop'])('blocks and records the posts of a page that goes away at %s', async (how) => {
    const h = harness(how === 'the idle close' ? { idleMs: 1500 } : {});
    site.hits.length = 0;
    const page = await h.run('browser_open', { url: site.url('shop.test', '/unload') });
    await h.run('browser_type', { ref: refOf(page.content, /textbox "Note"/), element: 'note', text: 'TYPED-AT-UNLOAD' });
    if (how === 'browser_close') await h.run('browser_close', {});
    if (how === 'the app stop') await h.worker.stop();
    await vi.waitFor(() => expect(h.tasks()[0]).toMatchObject({ status: 'closed' }), { timeout: 10_000, interval: 100 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(site.hits.filter((hit) => hit.method !== 'GET')).toEqual([]);
    const last = h.steps().at(-1)!;
    expect(last.action).toBe('close');
    const blocked = (JSON.parse(String(last.blockedRequests)) as Array<{ url: string }>).map((each) => each.url);
    expect(blocked).toEqual(expect.arrayContaining([site.url('evil.test', '/beacon-pagehide'), site.url('evil.test', '/keepalive-pagehide'), site.url('shop.test', '/own-beacon-pagehide')]));
  });

  it('keeps the first 200 blocked requests of a step and counts the others', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/flood') });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const out = await h.run('browser_snapshot', {});
    const blocked = JSON.parse(String(h.steps().at(-1)!.blockedRequests)) as Array<{ url: string; reason: string }>;
    expect(blocked).toHaveLength(201);
    const [, more] = /^(\d+) more blocked requests were not kept$/.exec(blocked.at(-1)!.reason)!;
    expect(Number(more)).toBeGreaterThan(200);
    expect(out.content).toContain(`Blocked ${200 + Number(more)} requests:`);
  });

  it('lets an image button send one click position, and refuses a field of that name that a script adds', async () => {
    const h = harness();
    const url = site.url('shop.test', '/image-form');
    const posts = () => site.hitsOn('shop.test').filter((hit) => hit.method === 'POST');
    await h.run('browser_open', { url });
    site.hits.length = 0;
    expect((await h.run('browser_submit', { url, button: 'Go', fields: { note: 'hello' } })).isError).toBe(false);
    // an image button without a name sends x and y.
    await h.run('browser_open', { url });
    expect((await h.run('browser_submit', { url, button: 'Order', fields: { item: 'pen' } })).isError).toBe(false);
    expect(posts().map((hit) => hit.body)).toEqual([expect.stringMatching(/^note=hello&go\.x=\d+&go\.y=\d+$/), expect.stringMatching(/^item=pen&x=\d+&y=\d+$/)]);
    for (const injected of ['INJECTED', '12']) {
      await h.run('browser_open', { url: `${url}#${injected}` });
      site.hits.length = 0;
      const out = await h.run('browser_submit', { url: `${url}#${injected}`, button: 'Go', fields: { note: 'hello' } });
      expect(out.content).toContain('the page changed the form after the check');
      expect(posts()).toEqual([]);
    }
  });

  it('refuses a file that a script puts into an empty file field at the click', async () => {
    const h = harness();
    const url = site.url('shop.test', '/file-form');
    const posts = () => site.hitsOn('shop.test').filter((hit) => hit.method === 'POST');
    await h.run('browser_open', { url });
    site.hits.length = 0;
    expect((await h.run('browser_submit', { url, button: 'Send', fields: { note: 'hello', f: '' } })).isError).toBe(false);
    expect(posts()).toHaveLength(1);
    await h.run('browser_open', { url: `${url}#x` });
    site.hits.length = 0;
    const out = await h.run('browser_submit', { url: `${url}#x`, button: 'Send', fields: { note: 'hello', f: '' } });
    expect(out.content).toContain('the page changed the form after the check');
    expect(posts()).toEqual([]);
  });

  it('sends no webrtc packet over udp, also to an address of this pc', async () => {
    const udp = createSocket('udp4');
    const packets: Buffer[] = [];
    udp.on('message', (bytes) => packets.push(bytes));
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.5', resolve));
    try {
      const h = harness();
      await h.run('browser_open', { url: site.url('shop.test', `/rtc?udp=127.0.0.5:${udp.address().port}`) });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(packets).toEqual([]);
    } finally {
      udp.close();
    }
  });

  it('records a block after the last step when the task closes', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/late-evil') });
    // the refresh comes 1 s after the load, and no step comes after it.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await h.run('browser_close', {});
    expect(site.hitsOn('evil.test')).toEqual([]);
    const last = h.steps().at(-1)!;
    expect(last).toMatchObject({ action: 'close', runId: 'run-1' });
    expect(JSON.parse(String(last.blockedRequests))).toContainEqual(expect.objectContaining({ url: site.url('evil.test', '/late?leak=1') }));
  });

  it('keeps a secret in an address out of the step rows and the trace', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', `/about?key=${PATTERN_KEY}`) });
    await h.run('browser_close', {});
    const rows = JSON.stringify(h.steps());
    expect(rows).toContain('about?key=');
    expect(rows).not.toContain(PATTERN_KEY);
    const trace = [...traceEntries(join(h.dir, 'traces', 'task-1.zip')).values()].map((bytes) => bytes.toString('latin1')).join('\n');
    expect(trace).not.toContain(PATTERN_KEY);
  });

  it('closes the tab when its task row cannot be written, so chrome can still close and free the profile', async () => {
    const db = openDb(':memory:');
    const prepare = db.prepare.bind(db);
    let fail = true;
    db.prepare = ((sql: string) => {
      if (fail && sql.startsWith('INSERT INTO browser_tasks')) {
        fail = false;
        throw new Error('database is locked');
      }
      return prepare(sql);
    }) as typeof db.prepare;
    const h = harness({ db, idleMs: 1500 });
    expect(await h.run('browser_open', { url: site.url('shop.test') })).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('database is locked') });
    expect((await h.run('browser_open', { url: site.url('shop.test') })).isError).toBe(false);
    await h.run('browser_close', {});
    await vi.waitFor(() => expect(profileBusy(join(h.dir, 'profile'))).toBe(false), { timeout: 10_000, interval: 250 });
  });

  // a server on another loopback address stands for the owner's network. the fixture egress refuses that address.
  async function startLan() {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>lan</p>');
    });
    server.on('upgrade', (req, socket) => {
      hits.push(`UPGRADE ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.5', resolve));
    const port = (server.address() as { port: number }).port;
    return { port, hits, close: () => new Promise((resolve) => server.close(resolve)) };
  }
  const allBlocked = (h: Harness) => h.steps().flatMap((step) => (step.blockedRequests ? (JSON.parse(String(step.blockedRequests)) as Array<{ url: string; reason: string }>) : []));

  // a shared worker belongs to no tab, so no page layer saw it, and a web socket of a dedicated worker skips the
  // socket route of the tab. both reached the owner's network.
  it('starts no shared worker, and keeps the requests and sockets of a worker off the owner network', async () => {
    const lan = await startLan();
    try {
      const h = harness();
      site.hits.length = 0;
      await h.run('browser_open', { url: site.url('shop.test', `/workers?lan=${lan.port}`) });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const out = await h.run('browser_snapshot', {});
      expect(out.content).toContain('no shared worker');
      expect(lan.hits).toEqual([]);
      expect(site.hitsOn('evil.test').filter((hit) => hit.method !== 'GET')).toEqual([]);
      const blocked = allBlocked(h);
      expect(blocked).toContainEqual({ url: `http://127.0.0.5:${lan.port}/worker-get`, reason: expect.stringContaining('local network') });
      expect(blocked).toContainEqual({ url: `127.0.0.5:${lan.port}`, reason: expect.stringContaining('local network') });
    } finally {
      await lan.close();
    }
  });

  // chrome preloads the pages of speculation rules outside the tab, and the activation of a prerender sends no request,
  // so a click could show an off-list page.
  it('preloads no page of the speculation rules', async () => {
    const lan = await startLan();
    try {
      const h = harness();
      site.hits.length = 0;
      const page = await h.run('browser_open', { url: site.url('shop.test', `/speculation?lan=${lan.port}`) });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const out = await h.run('browser_click', { ref: refOf(page.content, /link "Prerendered"/), element: 'Prerendered link' });
      expect(out.content).toContain(`Address: ${site.url('shop.test', `/speculation?lan=${lan.port}`)}`);
      expect(lan.hits).toEqual([]);
      expect(site.hitsOn('evil.test')).toEqual([]);
      // chrome does not even try: the proxy refused nothing.
      expect(allBlocked(h).filter((each) => each.url.includes('127.0.0.5'))).toEqual([]);
    } finally {
      await lan.close();
    }
  });

  // the gate resolved a name in node, and chrome resolved it again, so a name that pointed elsewhere the second time
  // (dns rebinding) reached the owner's network. chrome now connects through the proxy, to the address it checked.
  it('connects to the address that the gate checked, also when the name would resolve elsewhere for chrome', async () => {
    const lan = await startLan();
    try {
      const h = harness({ args: ['--host-resolver-rules=MAP rebind.test 127.0.0.5, MAP *.test 127.0.0.1'] });
      await h.run('browser_open', { url: site.url('shop.test', `/rebind?lan=${lan.port}`) });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await h.run('browser_snapshot', {});
      expect(lan.hits).toEqual([]);
    } finally {
      await lan.close();
    }
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

  it('never reaches the dashboard on this pc from a page: images, frames, a script and redirect hops', async () => {
    // a stand-in for the dashboard. it listens on every address, so localhost and ::ffff:7f00:1 both reach it.
    const dashboard: string[] = [];
    const server = createServer((req, res) => (dashboard.push(`${req.method} ${req.url}`), res.end('ok')));
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '::', ipv6Only: false }, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // the address form reaches the stand-in without the gate.
      await new Promise((resolve) => get(`http://[::ffff:7f00:1]:${port}/probe`, (res) => res.resume().on('end', resolve)));
      expect(dashboard).toEqual(['GET /probe']);
      dashboard.length = 0;
      const h = harness();
      let page = await h.run('browser_open', { url: site.url('shop.test', `/dash?port=${port}`) });
      for (const link of ['Dashboard 0', 'Dashboard 1']) page = await h.run('browser_click', { ref: refOf(page.content, new RegExp(`link "${link}"`)), element: link });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(dashboard).toEqual([]);
      const blocked = h.steps().flatMap((step) => (step.blockedRequests ? (JSON.parse(String(step.blockedRequests)) as Array<{ url: string }>) : []));
      for (const host of ['localhost', '[::ffff:7f00:1]']) expect(blocked.filter((each) => each.url.includes(`${host}:${port}`)).length, host).toBeGreaterThanOrEqual(3);
    } finally {
      server.close();
    }
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
    // the refused open came before chrome, so no gate saw it. the next row of the task keeps it.
    expect(JSON.parse(String(h.steps().at(-1)!.blockedRequests))).toContainEqual(expect.objectContaining({ url: site.url('evil.test'), reason: expect.stringContaining('browser_open refused it') }));
  });

  it('opens only web addresses, and never puts a public suffix on the allowlist', async () => {
    const h = harness();
    for (const url of ['chrome://history/', 'chrome://settings/', 'file:///C:/', `http://user:pw@shop.test:${site.port}/`, `http://test:${site.port}/`, `http://www.co.uk:${site.port}/`]) {
      expect(await h.run('browser_open', { url }), url).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('Nothing was opened') });
    }
    expect(h.tasks()).toEqual([]);
    await h.run('browser_open', { url: site.url('shop.test') });
    for (const domain of ['co.uk', 'www.co.uk', 'com.au']) {
      expect(await h.run('browser_allow_domain', { url: site.url('shop.test'), domain, reason: 'test' }), domain).toMatchObject({ isError: true, content: expect.stringContaining('was not added') });
    }
    // www.com is a site of its own, so it stays whole and does not allow every .com site.
    await h.run('browser_allow_domain', { url: site.url('shop.test'), domain: 'www.com', reason: 'test' });
    expect(JSON.parse(String(h.tasks()[0]!.allowlist))).toEqual(['shop.test', 'www.com']);
    expect(siteOf('www.com')).toBe('www.com');
    expect(siteOf('WWW.Shop.test.')).toBe('shop.test');
  });

  it('keeps the task of a session from another session, also when it is idle for more than a minute', async () => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test') }, 'main');
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 61_000);
    try {
      expect(await h.run('browser_open', { url: site.url('shop.test', '/about') }, 'auto:a:r')).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('busy') });
    } finally {
      clock.mockRestore();
    }
    expect(h.tasks()).toMatchObject([{ sessionKey: 'main', status: 'open' }]);
  });

  it('starts one task for two opens at the same moment, in one session or in two', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.run('browser_open', { url: site.url('shop.test') }), h.run('browser_open', { url: site.url('shop.test', '/about') })]);
    expect([a.isError, b.isError]).toEqual([false, false]);
    expect(h.tasks()).toMatchObject([{ id: 'task-1', status: 'open' }]);
    await h.run('browser_close', {});
    expect(h.tasks()).toMatchObject([{ status: 'closed', traceError: null }]);
    const [c, d] = await Promise.all([h.run('browser_open', { url: site.url('shop.test') }, 'main'), h.run('browser_open', { url: site.url('shop.test') }, 'auto:job')]);
    expect([c.isError, d.isError]).toEqual([false, true]);
    expect(d.content).toContain('busy');
    expect(h.tasks().filter((task) => task.status === 'open')).toMatchObject([{ sessionKey: 'main' }]);
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
    let typed = await h.run('browser_type', { ref: refOf(first.content, /textbox "Name"/), element: 'name', text: 'Ada' });
    // a key that the pattern finds, and a value that the app registered as a secret.
    registerSecret(REGISTERED);
    for (const secret of [PATTERN_KEY, REGISTERED]) typed = await h.run('browser_type', { ref: refOf(typed.content, /textbox "Name"/), element: 'name', text: secret });
    expect(typed.isError).toBe(false);
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
    // a text with a secret is typed outside the trace.
    expect(text).not.toContain(PATTERN_KEY);
    expect(text).not.toContain(REGISTERED);
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

  it.each([
    ['browser_extract', () => ({})],
    ['browser_click', (snapshot: string) => ({ ref: refOf(snapshot, /button "Freeze"/), element: 'Freeze' })],
  ])('ends the task when the page hangs between two steps, and %s and the close do not wait for ever', async (tool, input) => {
    const h = harness();
    await h.run('browser_open', { url: site.url('shop.test', '/freeze') });
    const freeze = await h.run('browser_snapshot', {});
    const clicked = await h.run('browser_click', { ref: refOf(freeze.content, /button "Freeze"/), element: 'Freeze' });
    // the loop starts 500 ms after the click, when no step runs.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const out = await h.run(tool, input(clicked.content));
    expect(out).toMatchObject({ isError: true, content: expect.stringContaining('stopped responding') });
    expect(await h.run('browser_close', {})).toMatchObject({ content: 'no browser task was open' });
    expect(h.tasks()[0]).toMatchObject({ status: 'crashed', endReason: 'the page stopped responding' });
    expect(h.steps().at(-1)).toMatchObject({ error: expect.stringContaining('no answer within') });
    expect((await h.run('browser_open', { url: site.url('shop.test') }, 'auto:x')).isError).toBe(false);
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
