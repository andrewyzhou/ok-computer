import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { ByteStore } from '../observability/byte-blobs.js';
import type { Logger } from '../observability/logger.js';
import { redact, redactedJson } from '../observability/redact.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import { checkUrlShape, type Egress } from '../web/egress.js';
import { allowedBy, guardContext, guardSockets, guardTab, siteOf, tooBroad, type ApprovedForm, type Blocked, type Layer, type Sent, type TabRules } from './gate.js';
import { startEgressProxy, type EgressProxy } from './proxy.js';

export interface BrowserDeps {
  db: Db;
  blobs: BlobStore;
  bytes: ByteStore;
  logger: Logger;
  clock: Clock;
  // data/browser: the profile, the downloads and the trace zips.
  dir: string;
  egress: Egress;
  // false in npm run chat. one chrome can use the profile, and the background app owns it.
  enabled: boolean;
  // tests point the *.test names at the fixture site. the app gives none.
  args?: string[];
  newId?: () => string;
  idleMs?: number;
  timeouts?: Partial<Timeouts>;
}

interface Timeouts {
  action: number;
  navigation: number;
  capture: number;
}

const TIMED_OUT = Symbol('timed out');

// some calls have no timeout of their own, for example page.title() and tracing.stop(), and a hung page holds them for
// ever. the work goes on, but the step does not wait for it.
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)));
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

// the snapshot of a page with 10,000 table rows took longer than 5 s, and a step with no snapshot and no screenshot
// counts as a hung page, so the task ended (r4 probe). the cost is that a hung page holds its tab longer before it
// closes.
const TIMEOUTS: Timeouts = { action: 10_000, navigation: 30_000, capture: 15_000 };
const IDLE_MS = 10 * 60_000;
// a page that the gate keeps blocking, for example with a fetch post in a loop, put 174,000 entries into one list in a
// minute, and the row of the next step grew to 293 MB. each list keeps its first entries and counts the others.
const KEEP = 200;
const URL_CHARS = 1000;
// the reporting api sends its reports from the network service, outside any frame, so no page layer of the gate sees
// them. a page sent its own address, with text that the agent typed, to a host off the allowlist that way (r6 probe).
// network error logging sends its reports through the same service.
const FEATURES_OFF = ['Reporting', 'NetworkErrorLogging'];
const DISABLE = '--disable-features=';

// a step is one action in a tab. its row keeps what the page looked like after the action.
export interface StepInput {
  sessionKey: string;
  runId: string;
  toolCallId?: string;
  action: string;
  target?: string;
}

export interface StepResult {
  ok: boolean;
  // what the action says, for example an error or "typed 5 characters".
  note: string;
  url: string;
  title: string;
  snapshot?: string;
  blocked: Blocked[];
  // the blocked requests that the list did not keep, because a page sent too many.
  blockedMore: number;
  // the requests that an approved submit let out, other than get.
  sent: Sent[];
  stepId?: number;
  taskId: string;
  // false when the action refused before it touched the page.
  acted: boolean;
}

// a failure before any action, for example no chrome or no open task. effect none: nothing happened in a page.
export interface BrowserRefusal {
  refused: string;
}

// an action throws this when it refuses before it touches the page, for example for a ref of an older snapshot. the
// step is still recorded, and the tool says that nothing happened.
export class NotDone extends Error {}

// the tab state that an action can read and change.
export interface ActTab {
  allowlist: ReadonlySet<string>;
  // the number of the last snapshot. its refs carry it, for example s3e12.
  snapshot: number;
  // the form data set of an approved submit while it runs, else undefined.
  setSubmit(form: ApprovedForm | undefined): void;
  // waits for the request of the approved form, and then until the page sends no more data for settleMs. it stops
  // early when the gate refused the page's own send, because then the form cannot leave. with any, the first request
  // with data that the gate lets out counts as the form, for a control whose script chooses what it sends.
  waitForSent(ms: number, settleMs: number, any?: boolean): Promise<SubmitOutcome>;
}

export interface SubmitOutcome {
  // the gate let the request of the approved form out.
  form: boolean;
  // the gate refused a page navigation with data, for example a form that a script changed at the click.
  refused: boolean;
  // the requests with data that the gate refused while the submit ran.
  blocked: number;
}

interface Tab {
  id: string;
  kind: 'task' | 'search';
  sessionKey: string;
  page: Page;
  allowlist: Set<string>;
  submit?: ApprovedForm;
  blocked: Blocked[];
  sent: Sent[];
  // the times that each layer of the gate saw a request with the same method, address and body, since the last record.
  seen: Map<string, Record<Layer, number>>;
  // the hosts off the allowlist that the gate let a request reach in this step.
  reached: Set<string>;
  // the entries that the lists did not keep since the last record.
  more: { blocked: number; sent: number; reached: number };
  // a navigation of the page itself was blocked in this step.
  topBlocked: boolean;
  // the gate refused a page navigation that sends data, for example a form that a script changed at the click.
  sendRefused: boolean;
  // the state of the submit that runs: the form left, the requests with data that the gate refused, and the time of the
  // last request with data.
  formSent: boolean;
  anySent: boolean;
  sendBlocked: number;
  lastSendAt: number;
  // the address after the last step that did not end on the error page of chrome.
  lastPage?: string;
  console: string[];
  // the dialogs of the page since the last step, as the step says them.
  dialogs: string[];
  lastUsed: number;
  queue: Promise<unknown>;
  crashed?: string;
  rules: TabRules;
  snapshot: number;
  // the run of the last step. a row that the close writes belongs to it.
  runId: string;
}

export interface BrowserWorker {
  // open starts the task of the session at its first call, and the host of the address joins its allowlist.
  open(step: StepInput, url: string): Promise<StepResult | BrowserRefusal>;
  // act runs one action in the open task of the session, one action at a time, and records the step.
  // scope open acts on the one open task, whichever session started it. a submit uses it: a child session opens the
  // page, and its parent sends the form after the owner approves.
  act(step: StepInput, action: (page: Page, tab: ActTab) => Promise<string | void>, scope?: 'session' | 'open'): Promise<StepResult | BrowserRefusal>;
  // search runs in a short tab of its own with the hosts of the engine, and records one step.
  inTab<T>(step: StepInput, hosts: string[], work: (page: Page) => Promise<T>): Promise<{ value?: T; error?: string; result: StepResult } | BrowserRefusal>;
  // allow adds a domain to the one open task, when the task allows the host of pageUrl. the owner approved a domain
  // for the task of that page, not for any task.
  allow(pageUrl: string, domain: string): BrowserRefusal | { allowlist: string[] };
  close(sessionKey: string, reason: string): Promise<boolean>;
  // sweep closes the rows of tasks that no chrome of this process has, after a crash of the app.
  sweep(): number;
  stop(): Promise<void>;
}

// the trace keeps the result of each playwright call: the snapshot before the mask, the values of password fields, the
// html of the page. the playwright client leaves a call in an internal zone out of the trace. the zone is a private
// method of the client, so a test pins this: no password and no dom in the trace. the actions stay in the trace.
export function untraced<T>(page: Page, read: () => Promise<T>): Promise<T> {
  const client = page as unknown as { _wrapApiCall(work: () => Promise<T>, options: { internal: boolean }): Promise<T> };
  return client._wrapApiCall(read, { internal: true });
}

// the trace keeps the parameters of each action, for example the text of a fill or the address of a goto, and the
// dashboard serves the zip. an action whose text holds a secret runs outside the trace, and its step row keeps the
// text redacted.
export const untracedIfSecret = <T>(page: Page, text: string, act: () => Promise<T>): Promise<T> => (redact(text) === text ? act() : untraced(page, act));

// the ai snapshot shows the value of a password field as plain text. the model, the blobs and the trace must never get
// it, so each value is masked wherever it shows in the snapshot. the snapshot also shows the fields of each frame, and
// a page locator does not go into frames, so each frame is read.
async function passwordsOf(page: Page, ms: number): Promise<string[]> {
  const read = Promise.all(
    page.frames().map((frame) => frame.locator('input[type=password]').evaluateAll((inputs) => inputs.map((input) => (input as unknown as { value: string }).value))),
  );
  const values = await within(read, ms);
  if (values === TIMED_OUT) throw new Error(`Timeout ${ms}ms exceeded while the password fields were read`);
  return values.flat().filter((value) => value.length > 0);
}

// the snapshot does not show a value as it is. it removes soft hyphens and zero-width spaces, trims the value, makes each
// run of white space one space (also a tab or a line separator), and puts a value with some characters in quotes with
// escapes (playwright 1.64, normalizeWhiteSpace and yamlEscapeValueIfNeeded). a value with a space at its start was
// shown in plain text, so each form of a value is masked.
const shownForms = (value: string): string[] => {
  const shown = value.replace(/[​­]/g, '').trim().replace(/\s+/g, ' ');
  const escaped = shown.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => (c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\b' ? '\\b' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
  return [value, shown, escaped].filter((form) => form.length > 0);
};

// a page with many password fields, each with its own value, held the event loop for 246 s when each form of each
// value went through the whole snapshot (r4 probe: 3,000 values). one pass with all forms takes about 0.1 s for that
// page. above the cap the snapshot is not given, because a page that a person uses has few passwords.
const MAX_PASSWORDS = 200;

// the longest value goes first in the pattern, so a value that holds a shorter one is masked whole.
export function maskPasswords(snapshot: string, secrets: string[]): string {
  const values = [...new Set(secrets)];
  if (!values.length) return snapshot;
  if (values.length > MAX_PASSWORDS) throw new Error(`the page has ${values.length} password fields with a value, more than ${MAX_PASSWORDS}, so no snapshot is given`);
  const forms = [...new Set(values.flatMap(shownForms))].sort((a, b) => b.length - a.length);
  return snapshot.replace(new RegExp(forms.map((form) => form.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')).join('|'), 'g'), '••••••');
}

// playwright resolves a ref against the last snapshot of the page, and the next snapshot can give the same ref to
// another element. the number of the snapshot in each ref lets a tool refuse a ref that the model read earlier.
export const renumber = (snapshot: string, n: number) => snapshot.replace(/\[ref=((?:f\d+)?e\d+)\]/g, `[ref=s${n}$1]`);

// chrome keeps a file named lockfile open while it uses a profile, and windows refuses a second open (probe p4). this
// is exact, also after a crash of the app, so the app needs no lock file of its own.
export function profileBusy(profile: string): boolean {
  const path = join(profile, 'lockfile');
  if (!existsSync(path)) return false;
  try {
    closeSync(openSync(path, 'r+'));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EBUSY' || (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type Json = Record<string, unknown>;
const merge = (base: Json, add: Json): Json => {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(add)) {
    const old = out[key];
    out[key] = value && typeof value === 'object' && old && typeof old === 'object' ? merge(old as Json, value as Json) : value;
  }
  return out;
};

// chrome keeps these preferences when they exist before it starts (probe p5). they turn off password saving and
// autofill, and send downloads to the folder of the app. a damaged file is replaced, because chrome would reset it.
export function hardenProfile(profile: string, downloads: string): void {
  const path = join(profile, 'Default', 'Preferences');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  let current: Json = {};
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    current = {};
  }
  const hardened = merge(current, {
    credentials_enable_service: false,
    profile: { password_manager_enabled: false },
    autofill: { profile_enabled: false, credit_card_enabled: false },
    download: { default_directory: downloads, prompt_for_download: false },
    // 2 is "never": no preload of links and no speculation rules. a preload runs outside the tab, so no page layer of the
    // gate sees it, and the activation of a prerender sends no request.
    net: { network_prediction_options: 2 },
    // webrtc sends udp, which the proxy does not carry, so a page sent stun packets with text that it chose to this pc.
    // with this policy webrtc uses only the proxy. the flag --force-webrtc-ip-handling-policy did not stop it (probe).
    webrtc: { ip_handling_policy: 'disable_non_proxied_udp' },
  });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(hardened));
  renameSync(temp, path);
}

export function createBrowserWorker(deps: BrowserDeps): BrowserWorker {
  const { db, logger, clock } = deps;
  const t = { ...TIMEOUTS, ...deps.timeouts };
  const idleMs = deps.idleMs ?? IDLE_MS;
  const newId = deps.newId ?? (() => `bt_${randomUUID()}`);
  const profile = join(deps.dir, 'profile');
  const downloads = join(deps.dir, 'downloads');
  const traces = join(deps.dir, 'traces');
  const tabs = new Map<Page, Tab>();
  const tasks = new Map<string, Tab>();
  let context: BrowserContext | undefined;
  let launching: Promise<BrowserContext> | undefined;
  let closing = false;
  let idleClose: Promise<unknown> = Promise.resolve();
  // the work that starts or ends a tab. the idle close waits for it: a close while a tab was made left newPage pending
  // for ever, and each later open and search waited behind it (r6 probe).
  let busy = 0;
  const inUse = async <T>(work: () => Promise<T>): Promise<T> => {
    busy++;
    try {
      return await work();
    } finally {
      busy--;
    }
  };
  let tracing: string | undefined;
  // the end of the task that has the trace. a task that started while it ended got no trace (a test under load), so a
  // new trace waits for it. each wait in the end of a task has a limit.
  let traceStop: Promise<unknown> = Promise.resolve();
  let userAgent: string | undefined;
  // the --disable-features of playwright, read at the first launch. empty when playwright gives none.
  let playwrightOff: string | undefined;
  let lastActivity = performance.now();
  let proxy: Promise<EgressProxy> | undefined;

  const now = () => clock().toISOString();

  const endRow = (id: string, status: string, reason: string, trace: { path?: string; bytes?: number; error?: string } = {}) => {
    try {
      db.prepare(
        "UPDATE browser_tasks SET status = ?, endReason = ?, endedAt = ?, tracePath = ?, traceBytes = ?, traceError = COALESCE(?, traceError) WHERE id = ? AND status = 'open'",
      ).run(status, reason, now(), trace.path ?? null, trace.bytes ?? null, trace.error ?? null, id);
    } catch (err) {
      logger.error('browser task row update failed', { taskId: id, err });
    }
  };

  // chrome stopped: every tab is gone, and a trace that was not saved is lost. the steps are already in the store.
  const onContextClosed = () => {
    context = undefined;
    if (!closing) {
      logger.warn('the browser stopped', { tasks: [...tasks.keys()] });
      for (const tab of tabs.values()) endRow(tab.id, 'crashed', 'the browser stopped', tab.id === tracing ? { error: 'the browser stopped before the trace was saved' } : {});
      tabs.clear();
      tasks.clear();
    }
    // the trace belongs to the context. a task id that stayed here gave no later task a trace until the app restarted.
    tracing = undefined;
  };

  const ownTask = () => [...tasks.values()][0];

  async function launch(): Promise<BrowserContext> {
    if (profileBusy(profile)) throw new Error('profile busy');
    mkdirSync(downloads, { recursive: true });
    hardenProfile(profile, downloads);
    // serviceWorkers 'block' only stops a page from registering a worker, and it hides the requests of a worker from
    // the page layers of the gate. a worker that a site registered in okc browser login still controlled its pages, so
    // a click sent a post with no approval, and typed text reached an off-list host (r8 probe). the agent chrome starts
    // with no worker.
    rmSync(join(profile, 'Default', 'Service Worker'), { recursive: true, force: true });
    // no other chrome holds the profile, so no task row that is open can be live. the app crashed while it ran.
    sweep();
    proxy ??= startEgressProxy(
      deps.egress,
      (url, reason) => {
        // the proxy does not know the tab, so each open tab records the block.
        for (const tab of tabs.values()) block(tab, { url, reason });
      },
      (host) => {
        // a host that no open tab allows can come from a channel that no page layer sees, so each open tab records it.
        const open = [...tabs.values()];
        if (!open.some((tab) => allowedBy(tab.allowlist, host))) for (const tab of open) tab.rules.onReached(host);
      },
    );
    const { url: proxyUrl } = await proxy;
    // chrome uses only the last --disable-features, and playwright gives a list of its own (a second list turned storage
    // partitioning back on, probe). the first launch only reads that list, and the next launches replace it with a
    // list that also has the features of the app.
    const start = () =>
      chromium.launchPersistentContext(profile, {
        ...(playwrightOff ? { ignoreDefaultArgs: [playwrightOff] } : {}),
        channel: 'chrome',
        headless: true,
        serviceWorkers: 'block',
        // no tool works with a file, and a download is a file that a page puts on this pc without a step.
        acceptDownloads: false,
        viewport: { width: 1280, height: 800 },
        args: [
          // <-loopback> also sends the addresses of this pc through the proxy, which chrome otherwise connects to directly.
          `--proxy-server=${proxyUrl}`,
          '--proxy-bypass-list=<-loopback>',
          // a shared worker belongs to no tab, so no page layer of the gate sees its requests or its sockets.
          '--disable-blink-features=SharedWorker',
          ...(playwrightOff !== undefined ? [`${DISABLE}${[playwrightOff.slice(DISABLE.length), ...FEATURES_OFF].filter(Boolean).join(',')}`] : []),
          ...(deps.args ?? []),
        ],
        ...(userAgent ? { userAgent } : {}),
      });
    let ctx = await start();
    // headless chrome names itself HeadlessChrome in its user agent, and a search engine shows more captchas to it. the
    // first launch reads the name and the list of playwright, and chrome starts once more with both.
    if (!userAgent) {
      const first = ctx.pages()[0] ?? (await ctx.newPage());
      const agent = await first.evaluate(() => navigator.userAgent);
      await first.goto('chrome://version');
      playwrightOff = /--disable-features=\S*/.exec(await first.locator('#command_line').innerText())?.[0] ?? '';
      userAgent = agent.replace('HeadlessChrome/', 'Chrome/');
      await ctx.close();
      ctx = await start();
    }
    // a page with webrtc can reach a turn server through the proxy, which checks only the address, and no page layer
    // sees it. a page sent text that the agent typed to a host off the allowlist in the user name (r6 probe). no
    // switch of chrome removes the api, so each document loses it before its own scripts run, also a frame that a
    // script makes.
    await ctx.addInitScript(() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) delete (globalThis as Record<string, unknown>)[name];
    });
    ctx.on('close', onContextClosed);
    await guardContext(
      ctx,
      deps.egress,
      (page) => tabs.get(page)?.rules,
      (url) => {
        // a popup belongs to no tab. it is refused, and the open task records it.
        const task = ownTask();
        if (task) block(task, { url, reason: 'a new tab or window is refused. Use browser_open with its address' });
      },
    );
    // a page that the app did not open is a popup. the route refuses its requests at once, and it closes here. the
    // event can come before newPage gives the app its own page, so the test waits a moment.
    for (const page of ctx.pages()) owned.add(page);
    ctx.on('page', (page) => void setTimeout(() => !owned.has(page) && void page.close().catch(() => undefined), 1000));
    return ctx;
  }

  const owned = new WeakSet<Page>();
  async function contextOrRefusal(): Promise<BrowserContext | BrowserRefusal> {
    if (!deps.enabled) return { refused: 'The browser runs only in the background app, not in this chat process.' };
    if (context) return context;
    // the chrome of the idle close holds the profile until it ends. a launch before that failed, and the refusal
    // blamed another chrome window (r6 probe).
    await idleClose;
    if (context) return context;
    launching ??= launch().finally(() => (launching = undefined));
    try {
      context = await launching;
      return context;
    } catch (err) {
      // a second chrome on the profile fails with "target page, context or browser has been closed" (probe p3), so
      // the lock file tells the real reason.
      if (profileBusy(profile)) {
        return { refused: 'The agent browser profile is in use by another Chrome window, for example okc browser login. Try again after it closes.' };
      }
      logger.error('the browser did not start', { err });
      return { refused: `The browser did not start: ${errorText(err).split('\n')[0]}` };
    }
  }

  async function newTab(ctx: BrowserContext, kind: Tab['kind'], step: StepInput, allowlist: string[]): Promise<Tab> {
    const page = await ctx.newPage();
    owned.add(page);
    const tab = { id: newId(), kind, sessionKey: step.sessionKey, page, allowlist: new Set(allowlist), blocked: [], sent: [], seen: new Map(), reached: new Set(), more: { blocked: 0, sent: 0, reached: 0 }, formSent: false, anySent: false, sendBlocked: 0, lastSendAt: 0, console: [], dialogs: [], lastUsed: performance.now(), queue: Promise.resolve(), snapshot: 0, runId: step.runId } as unknown as Tab;
    tab.rules = {
      allows: (host) => allowedBy(tab.allowlist, host),
      submitting: () => tab.submit,
      onBlocked: (blocked, top, sends) => {
        // the search reads a consent wall only from a block of its own page, not of a frame or of the proxy.
        block(tab, top ? { ...blocked, top } : blocked);
        if (top) tab.topBlocked = true;
        if (top && sends) tab.sendRefused = true;
        if (sends && tab.submit) {
          tab.sendBlocked++;
          tab.lastSendAt = performance.now();
        }
      },
      // the route and the cdp layer both see most requests, so one request comes here twice. a key of the method and
      // the address alone also dropped a second post with other data, for example the order after a check, and it left
      // with no record (r7 probes). a layer that saw a key no more often than the other layer adds no entry.
      onSent: (sent, layer) => {
        if (sent.form) tab.formSent = true;
        if (tab.submit) tab.anySent = true;
        tab.lastSendAt = performance.now();
        const key = JSON.stringify([sent.method, sent.url, sent.body ?? '']);
        const seen = tab.seen.get(key) ?? { route: 0, cdp: 0 };
        seen[layer]++;
        tab.seen.set(key, seen);
        if (seen[layer] <= seen[layer === 'route' ? 'cdp' : 'route']) return;
        if (tab.sent.length < KEEP) tab.sent.push({ ...sent, url: sent.url.slice(0, URL_CHARS) });
        else tab.more.sent++;
      },
      onReached: (host) => {
        if (tab.reached.has(host)) return;
        if (tab.reached.size < KEEP) tab.reached.add(host);
        else tab.more.reached++;
      },
    };
    page.setDefaultTimeout(t.action);
    page.setDefaultNavigationTimeout(t.navigation);
    page.on('crash', () => (tab.crashed = 'the page crashed'));
    page.on('console', (message) => message.type() === 'error' && tab.console.length < 20 && tab.console.push(message.text().slice(0, 300)));
    page.on('pageerror', (error) => tab.console.length < 20 && tab.console.push(error.message.slice(0, 300)));
    // with no handler, playwright dismisses each dialog. an approved form that asked confirm() was then never sent, and
    // no step said why (r7 probe). the owner approved the submit, so a dialog while it runs is accepted. a dialog at
    // another moment is dismissed, but a dialog before the page unloads is accepted, so the agent can leave the page.
    // each step names the dialogs of the page.
    page.on('dialog', (dialog) => {
      const accept = tab.submit !== undefined || dialog.type() === 'beforeunload';
      const line = `The page showed a ${dialog.type()} dialog ${JSON.stringify(dialog.message().slice(0, 300))}, and the browser ${accept ? 'accepted' : 'dismissed'} it`;
      if (tab.dialogs.length < 20) tab.dialogs.push(line);
      if (tab.console.length < 20) tab.console.push(line);
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    // the tab gets no address before both layers of the gate are in place.
    try {
      await guardTab(await ctx.newCDPSession(page), deps.egress, tab.rules);
      await guardSockets(page, deps.egress, tab.rules);
    } catch (err) {
      await page.close().catch(() => undefined);
      throw err;
    }
    // a tab with no row would be in no task map, so no close would end it, and chrome would keep the profile lock
    // until the app restarts. the tab closes when the row fails.
    try {
      db.prepare('INSERT INTO browser_tasks (id, kind, sessionKey, runId, allowlist, status, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        tab.id,
        kind,
        step.sessionKey,
        step.runId,
        JSON.stringify([...tab.allowlist]),
        'open',
        now(),
      );
    } catch (err) {
      await page.close().catch(() => undefined);
      throw err;
    }
    tabs.set(page, tab);
    if (kind === 'task') {
      // the trace belongs to the context, so one task at a time has it. the row says why a task has no trace.
      try {
        await traceStop;
        if (tracing) throw new Error(`task ${tracing} still has the trace`);
        // a dom snapshot also turns on the network log of the trace, with the cookie of each request. the screenshots
        // and the action list stay, and each step keeps the masked snapshot that the model read.
        await ctx.tracing.start({ screenshots: true, snapshots: { dom: false, aria: false, screen: true }, title: tab.id });
        tracing = tab.id;
      } catch (err) {
        logger.warn('the browser trace did not start', { taskId: tab.id, err });
        try {
          db.prepare('UPDATE browser_tasks SET traceError = ? WHERE id = ?').run(`the trace did not start: ${errorText(err).split('\n')[0]}`, tab.id);
        } catch (dbErr) {
          logger.error('browser task row update failed', { taskId: tab.id, err: dbErr });
        }
      }
    }
    return tab;
  }

  async function startTab(ctx: BrowserContext, kind: Tab['kind'], step: StepInput, allowlist: string[]): Promise<Tab | BrowserRefusal> {
    try {
      return await newTab(ctx, kind, step, allowlist);
    } catch (err) {
      logger.error('the browser tab did not start', { err });
      return { refused: `The browser tab did not start: ${errorText(err).split('\n')[0]}. Nothing was opened.` };
    }
  }

  // the idle close waits for a tab that ends. a close in that moment lost the trace of the task, and its row said that
  // the app had stopped (r6 probe).
  const endTab = (tab: Tab, status: 'closed' | 'crashed', reason: string) => {
    const ending = inUse(() => closeTab(tab, status, reason));
    if (tracing === tab.id) traceStop = ending.catch(() => undefined);
    return ending;
  };

  async function closeTab(tab: Tab, status: 'closed' | 'crashed', reason: string): Promise<void> {
    const traced = tracing === tab.id;
    // a page can send data in its pagehide and unload handlers, for example a beacon with text that the agent typed. a
    // close runs them after the page layers of the gate stop, and the proxy checks only the address, so a probe got
    // every post out. the tab first goes to an empty page while the gate still holds, and the gate blocks and records
    // them. the requests of the unload reach the gate a moment after the navigation.
    if (!tab.crashed && !tab.page.isClosed()) {
      await within(untraced(tab.page, () => tab.page.goto('about:blank', { timeout: t.capture })), t.capture).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    tabs.delete(tab.page);
    if (tasks.get(tab.sessionKey) === tab) tasks.delete(tab.sessionKey);
    // a block after the last step, for example of a timed refresh, goes into the next row. no next row comes after a
    // close, so the close writes one.
    if (tab.blocked.length || tab.sent.length || tab.reached.size) {
      const url = tab.page.isClosed() ? '' : tab.page.url();
      record(tab, { sessionKey: tab.sessionKey, runId: tab.runId, action: 'close', target: reason }, { urlBefore: url, urlAfter: url, started: performance.now() });
      recorded(tab);
    }
    // the tab closes first. a hung page keeps its renderer busy, and with dom snapshots it also held the trace stop for
    // ever.
    await within(tab.page.close({ runBeforeUnload: false }), t.capture);
    let trace: { path?: string; bytes?: number; error?: string } = {};
    if (traced && !context) trace = { error: 'the browser stopped before the trace was saved' };
    if (traced && context) {
      tracing = undefined;
      mkdirSync(traces, { recursive: true });
      const path = join(traces, `${tab.id}.zip`);
      try {
        const stopped = await within(context.tracing.stop({ path: `${path}.tmp` }), t.navigation);
        if (stopped === TIMED_OUT) throw new Error(`no answer within ${t.navigation / 1000} s`);
        renameSync(`${path}.tmp`, path);
        trace = { path: `traces/${tab.id}.zip`, bytes: statSync(path).size };
      } catch (err) {
        rmSync(`${path}.tmp`, { force: true });
        trace = { error: `the trace was not saved: ${errorText(err).split('\n')[0]}` };
      }
    }
    endRow(tab.id, status, reason, trace);
  }

  async function capture(tab: Tab): Promise<{ snapshot?: string; jpeg?: Buffer; errors: string[] }> {
    const errors: string[] = [];
    let snapshot: string | undefined;
    let jpeg: Buffer | undefined;
    try {

      // a script can change a value while the snapshot runs, so the values before and after it are both masked.
      const text = await untraced(tab.page, async () => {
        const before = await passwordsOf(tab.page, t.capture);
        const raw = await tab.page.ariaSnapshot({ mode: 'ai', timeout: t.capture });
        return maskPasswords(raw, [...before, ...(await passwordsOf(tab.page, t.capture))]);
      });
      snapshot = renumber(text, ++tab.snapshot);
    } catch (err) {
      errors.push(`snapshot: ${errorText(err).split('\n')[0]}`);
    }
    try {
      // a jpeg at quality 60 is about four times smaller than a png on real pages, and it stays readable.
      jpeg = await tab.page.screenshot({ timeout: t.capture, type: 'jpeg', quality: 60 });
    } catch (err) {
      errors.push(`screenshot: ${errorText(err).split('\n')[0]}`);
    }
    return { snapshot, jpeg, errors };
  }

  // the record is written after the action. it fails open: a lost row is better than a second action.
  function record(tab: Tab, step: StepInput, data: { urlBefore: string; urlAfter: string; snapshot?: string; jpeg?: Buffer; error?: string; started: number }): number | undefined {
    let snapshotBlob: string | null = null;
    let screenshotBlob: string | null = null;
    try {
      if (data.snapshot !== undefined) snapshotBlob = deps.blobs.put(data.snapshot);
    } catch (err) {
      logger.error('browser snapshot blob write failed', { taskId: tab.id, err });
    }
    try {
      if (data.jpeg) screenshotBlob = deps.bytes.put(data.jpeg, 'image/jpeg');
    } catch (err) {
      logger.error('browser screenshot blob write failed', { taskId: tab.id, err });
    }
    try {
      const row = db
        .prepare(
          `INSERT INTO browser_steps (taskId, runId, toolCallId, action, target, urlBefore, urlAfter, snapshotBlob, screenshotBlob,
             consoleErrors, blockedRequests, sent, offsiteHosts, error, durationMs, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          tab.id,
          step.runId,
          step.toolCallId ?? null,
          step.action,
          step.target === undefined ? null : redactedJson(step.target),
          redact(data.urlBefore),
          redact(data.urlAfter),
          snapshotBlob,
          screenshotBlob,
          tab.console.length ? redactedJson(tab.console) : null,
          tab.blocked.length ? redactedJson(blockedOf(tab)) : null,
          tab.sent.length ? redactedJson(sentOf(tab)) : null,
          tab.reached.size ? JSON.stringify([...[...tab.reached].sort(), ...(tab.more.reached ? [`(${tab.more.reached} more hosts)`] : [])]) : null,
          // a navigation error names the address, which can hold a secret, as the target and the addresses can.
          data.error === undefined ? null : redact(data.error),
          Math.round(performance.now() - data.started),
          now(),
        );
      return Number(row!.id);
    } catch (err) {
      logger.error('browser step write failed', { taskId: tab.id, err });
      return undefined;
    }
  }

  // the lists start again only after a record. a block between two steps, for example of a timed refresh or a popup,
  // then goes into the record of the next step.
  function recorded(tab: Tab): void {
    tab.blocked = [];
    tab.sent = [];
    tab.seen = new Map();
    tab.reached = new Set();
    tab.more = { blocked: 0, sent: 0, reached: 0 };
    tab.console = [];
  }

  function block(tab: Tab, blocked: Blocked): void {
    if (tab.blocked.length < KEEP) tab.blocked.push({ ...blocked, url: blocked.url.slice(0, URL_CHARS) });
    else tab.more.blocked++;
  }

  // the last entry of a full list says how many entries it did not keep.
  const blockedOf = (tab: Tab): Blocked[] => [...tab.blocked, ...(tab.more.blocked ? [{ url: '…', reason: `${tab.more.blocked} more blocked requests were not kept` }] : [])];
  const sentOf = (tab: Tab): Sent[] => [...tab.sent, ...(tab.more.sent ? [{ method: '…', url: `${tab.more.sent} more sent requests were not kept` }] : [])];

  // one action at a time in a tab. the model can ask for several calls in one turn, and two actions in one page at
  // the same moment give a step record that belongs to neither.
  function serial<T>(tab: Tab, work: () => Promise<T>): Promise<T> {
    const next = tab.queue.then(work, work);
    tab.queue = next.catch(() => undefined);
    return next;
  }

  async function step(tab: Tab, input: StepInput, action: (page: Page) => Promise<string | void>): Promise<StepResult | BrowserRefusal> {
    return serial(tab, async () => {
      if (tab.crashed || tab.page.isClosed()) {
        const reason = tab.crashed ?? 'the tab closed';
        await endTab(tab, 'crashed', reason);
        return { refused: `The browser tab of this task stopped (${reason}). Its task ended. Use browser_open to start again.` };
      }
      const started = performance.now();
      tab.lastUsed = performance.now();
      tab.runId = input.runId;
      lastActivity = performance.now();
      tab.topBlocked = false;
      const urlBefore = tab.page.url();
      let note = '';
      let error: string | undefined;
      let acted = true;
      try {
        const out = await within(action(tab.page), deadline);
        if (out === TIMED_OUT) return await hung(tab, input, urlBefore, started);
        note = out ?? '';
      } catch (err) {
        error = errorText(err).split('\n')[0]!;
        acted = !(err instanceof NotDone);
      }
      // a navigation can still run. the snapshot waits for the document, with the capture limit.
      await tab.page.waitForLoadState('domcontentloaded', { timeout: t.capture }).catch(() => undefined);
      const stayed = [await leaveErrorPage(tab, urlBefore), ...tab.dialogs.splice(0).map((line) => `${line}.`)].filter(Boolean).join(' ');
      if (stayed) note = note ? `${note}. ${stayed}` : stayed;
      const shot = await capture(tab);
      const urlAfter = tab.page.url();
      if (!urlAfter.startsWith('chrome-error:')) tab.lastPage = urlAfter;
      const stepId = record(tab, input, { urlBefore, urlAfter, snapshot: shot.snapshot, jpeg: shot.jpeg, started, ...(error || shot.errors.length ? { error: [error, ...shot.errors].filter(Boolean).join('; ') } : {}) });
      const base = { url: urlAfter, blocked: [...tab.blocked], blockedMore: tab.more.blocked, sent: sentOf(tab), taskId: tab.id, acted, ...(shot.snapshot !== undefined ? { snapshot: shot.snapshot } : {}), ...(stepId ? { stepId } : {}) };
      recorded(tab);
      // a page that answers neither capture is hung, for example by a loop in its script. closing the tab is the only
      // way back (probe p5), and the next browser_open starts a new task.
      if (shot.errors.length === 2 && /Timeout/.test(shot.errors.join(' '))) {
        await endTab(tab, 'crashed', 'the page stopped responding');
        return { ...base, ok: false, title: '', note: `${error ? `${error}. ` : ''}The page stopped responding, so its tab closed and the task ended.` };
      }
      const title = await within(untraced(tab.page, () => tab.page.title()), t.capture).catch(() => '');
      return { ...base, ok: !error, note: error ? [error, stayed].filter(Boolean).join('. ') : note, title: typeof title === 'string' ? title : '' };
    });
  }

  // most calls of an action have a timeout of their own, but a read in the page (a count, an evaluate, the html) waits
  // for ever when a script of the page loops. the queue of the tab then also holds browser_close and the idle close.
  // the deadline is longer than any action with its own timeouts, so only a hung page reaches it.
  const deadline = t.navigation + 2 * t.action;

  // the action can still run, so the tab closes: it is the only way back from a hung page (probe p5). a capture would
  // only wait twice more.
  async function hung(tab: Tab, input: StepInput, urlBefore: string, started: number): Promise<StepResult> {
    const error = `the page gave no answer within ${deadline / 1000} s`;
    const stepId = record(tab, input, { urlBefore, urlAfter: tab.page.url(), started, error });
    const base = { url: tab.page.url(), blocked: [...tab.blocked], blockedMore: tab.more.blocked, sent: sentOf(tab), taskId: tab.id, acted: true, ...(stepId ? { stepId } : {}) };
    recorded(tab);
    await endTab(tab, 'crashed', 'the page stopped responding');
    return { ...base, ok: false, title: '', note: `${error}. The page stopped responding, so its tab closed and the task ended.` };
  }

  // a blocked navigation leaves chrome on its own error page. the model would read that page as the site, and its
  // host would become a taint source, so the tab goes back. the error page commits a moment after the block, so the
  // wait has a short limit. a block can also come between two steps, for example from a timed refresh, and then the
  // step starts on the error page.
  async function leaveErrorPage(tab: Tab, urlBefore: string): Promise<string | undefined> {
    const onError = () => tab.page.url().startsWith('chrome-error:');
    if (tab.topBlocked && !onError()) await tab.page.waitForURL((url) => url.protocol === 'chrome-error:', { timeout: 2_000 }).catch(() => undefined);
    if (!onError()) return undefined;
    // a refresh replaces its own entry in the history, so the way back can skip the page. the address is the target.
    const target = urlBefore.startsWith('chrome-error:') ? tab.lastPage : urlBefore;
    await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: t.capture }).catch(() => undefined);
    if (target && tab.page.url() !== target) {
      await untracedIfSecret(tab.page, target, () => tab.page.goto(target, { waitUntil: 'domcontentloaded', timeout: t.capture })).catch(() => undefined);
    }
    return `A navigation was blocked, so the tab went back to ${tab.page.url()}.`;
  }

  function sweep(): number {
    if (!deps.enabled) return 0;
    const live = new Set([...tabs.values()].map((tab) => tab.id));
    const open = db.prepare("SELECT id FROM browser_tasks WHERE status = 'open'").all().map((row) => String(row.id));
    let closed = 0;
    for (const id of open.filter((each) => !live.has(each))) {
      endRow(id, 'interrupted', 'the app stopped while the task was open', { error: 'the app stopped before the trace was saved' });
      closed++;
    }
    return closed;
  }

  // a task that waits long frees the browser for other sessions, and chrome closes when nothing uses it, so the owner
  // can open the profile with okc browser login.
  const timer = setInterval(() => {
    for (const tab of tasks.values()) if (performance.now() - tab.lastUsed > idleMs) void serial(tab, () => endTab(tab, 'closed', 'no browser action for a while'));
    if (context && !tabs.size && !busy && performance.now() - lastActivity > idleMs) {
      closing = true;
      const ctx = context;
      context = undefined;
      idleClose = ctx.close().catch(() => undefined).finally(() => (closing = false));
    }
  }, Math.min(60_000, idleMs));
  timer.unref();

  let opening: Promise<unknown> = Promise.resolve();
  async function claim(input: StepInput, url: URL): Promise<Tab | BrowserRefusal> {
    const host = url.hostname;
    const tab = tasks.get(input.sessionKey);
    if (tab && !allowedBy(tab.allowlist, host)) {
      // the refusal comes before chrome, so no gate sees it. the next row of the task keeps it with the blocks of the
      // gate, so the owner sees where the agent tried to go.
      block(tab, { url: url.href, reason: 'browser_open refused it, because it is not on the allowlist of this task' });
      return { refused: `${host} is not on the allowlist of this task (${[...tab.allowlist].join(', ')}). Use browser_allow_domain to ask the owner, or browser_close and start a new task.` };
    }
    if (tab) return tab;
    if (tooBroad(siteOf(host))) return { refused: `${host} is not a site that a task can start on, because its allowlist would allow every site under ${siteOf(host)}. Nothing was opened.` };
    // the task of another session can wait for the owner to approve a submit, for hours, so it is never taken.
    const other = ownTask();
    if (other) {
      return { refused: `The browser is busy with a task of another session (${other.sessionKey}). That task ends after ${Math.round(idleMs / 60_000)} minutes without an action. Try again later.` };
    }
    const created = await inUse(async () => {
      const ctx = await contextOrRefusal();
      return 'refused' in ctx ? ctx : startTab(ctx, 'task', input, [siteOf(host)]);
    });
    if ('refused' in created) return created;
    tasks.set(input.sessionKey, created);
    return created;
  }

  return {
    async open(input, url) {
      // a page of chrome itself, such as chrome://history, never passes the gate, so only web addresses open.
      const shape = checkUrlShape(url);
      if (!shape.ok) return { refused: `${shape.reason}. Nothing was opened.` };
      // the trace keeps the address of each console message of a page, and playwright cannot leave them out, so an
      // untraced goto did not keep a secret in the address out of the zip (r5 probe). an address never needs a secret.
      if (redact(url) !== url) return { refused: 'The address holds text with the shape of a secret, such as an api key. Nothing was opened. Open the page without it.' };
      // the check and the start of a task wait for chrome and a new tab. two opens at the same moment, in one turn or
      // from two sessions, would each start a task, so they run one at a time.
      const claimed = opening.then(() => claim(input, shape.url));
      opening = claimed.catch(() => undefined);
      const tab = await claimed;
      if ('refused' in tab) return tab;
      return step(tab, { ...input, target: url }, async (page) => {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        return response && response.status() >= 400 ? `the page answered with status ${response.status()}` : undefined;
      });
    },
    async act(input, action, scope = 'session') {
      const tab = scope === 'open' ? ownTask() : tasks.get(input.sessionKey);
      if (!tab) return { refused: `No page is open${scope === 'open' ? '' : ' in this session'}. Use browser_open first.` };
      return step(tab, input, (page) =>
        action(page, {
          allowlist: tab.allowlist,
          snapshot: tab.snapshot,
          setSubmit: (form) => {
            tab.submit = form;
            if (!form) return;
            tab.sendRefused = false;
            tab.formSent = false;
            tab.anySent = false;
            tab.sendBlocked = 0;
            tab.lastSendAt = performance.now();
          },
          // the first request with data is not always the form: a page sent a beacon, or the post of a check of its own,
          // before the form. the submit ended at that first request, so the gate refused the form (r5 probes).
          waitForSent: async (ms, settleMs, any = false) => {
            const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
            const start = performance.now();
            const left = () => (any ? tab.anySent : tab.formSent);
            while (!left() && !tab.sendRefused && performance.now() - start < ms) await tick();
            // a site can send its order after the answer to a first post, so the submit stays open while the page sends.
            if (left()) while (performance.now() - tab.lastSendAt < settleMs && performance.now() - start < 2 * ms) await tick();
            return { form: left(), refused: tab.sendRefused, blocked: tab.sendBlocked };
          },
        }),
      );
    },
    async inTab(input, hosts, work) {
      const tab = await inUse(async () => {
        const ctx = await contextOrRefusal();
        return 'refused' in ctx ? ctx : startTab(ctx, 'search', input, hosts.map(siteOf));
      });
      if ('refused' in tab) return tab;
      let value: Awaited<ReturnType<typeof work>> | undefined;
      let error: string | undefined;
      const result = await step(tab, input, async (page) => {
        try {
          value = await work(page);
        } catch (err) {
          error = errorText(err).split('\n')[0];
          throw err;
        }
      });
      if (tabs.has(tab.page)) await endTab(tab, 'closed', 'the search ended');
      if ('refused' in result) return result;
      // a hung page never ends the work, so the step says why. the close moves the hung tab to an empty page, and the
      // work then fails with another error, so the note of the step comes first.
      if (!result.ok) error = result.note;
      return { ...(value !== undefined ? { value } : {}), ...(error ? { error } : {}), result };
    },
    allow(pageUrl, domain) {
      const tab = ownTask();
      if (!tab) return { refused: 'No browser task is open, so there is no allowlist to change. The domain was not added.' };
      let host = '';
      try {
        host = new URL(pageUrl).hostname;
      } catch {
        // an address that does not parse matches no task.
      }
      if (!host || !allowedBy(tab.allowlist, host)) {
        return { refused: `The open browser task is for ${[...tab.allowlist].join(', ')}, not for ${JSON.stringify(pageUrl)}. The domain was not added. Ask again with the address of the open page.` };
      }
      if (tooBroad(siteOf(domain))) return { refused: `${domain} would allow every site under ${siteOf(domain)}. The domain was not added. Ask for the site itself, such as pay.example.com.` };
      tab.allowlist.add(siteOf(domain));
      try {
        db.prepare('UPDATE browser_tasks SET allowlist = ? WHERE id = ?').run(JSON.stringify([...tab.allowlist]), tab.id);
      } catch (err) {
        logger.error('browser allowlist write failed', { taskId: tab.id, err });
      }
      return { allowlist: [...tab.allowlist] };
    },
    async close(sessionKey, reason) {
      const tab = tasks.get(sessionKey);
      if (!tab) return false;
      await serial(tab, () => endTab(tab, 'closed', reason));
      return true;
    },
    sweep,
    async stop() {
      clearInterval(timer);
      for (const tab of [...tabs.values()]) await endTab(tab, 'closed', 'the app stopped').catch(() => undefined);
      closing = true;
      await context?.close().catch(() => undefined);
      context = undefined;
      await (await proxy)?.close();
      proxy = undefined;
    },
  };
}
