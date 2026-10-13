import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { ByteStore } from '../observability/byte-blobs.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import type { Egress } from '../web/egress.js';
import { allowedBy, guardContext, guardTab, siteOf, type Blocked, type Sent, type TabRules } from './gate.js';

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

const TIMEOUTS: Timeouts ={ action: 10_000, navigation: 30_000, capture: 5_000 };
const IDLE_MS = 10 * 60_000;

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
  setSubmit(on: boolean): void;
}

interface Tab {
  id: string;
  kind: 'task' | 'search';
  sessionKey: string;
  page: Page;
  allowlist: Set<string>;
  submit: boolean;
  blocked: Blocked[];
  sent: Sent[];
  // a navigation of the page itself was blocked in this step.
  topBlocked: boolean;
  // the address after the last step that did not end on the error page of chrome.
  lastPage?: string;
  console: string[];
  lastUsed: number;
  queue: Promise<unknown>;
  crashed?: string;
  rules: TabRules;
  snapshot: number;
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

// the ai snapshot shows the value of a password field as plain text. the model, the blobs and the trace must never get
// it, so each value is masked wherever it shows in the snapshot.
async function passwordsOf(page: Page, ms: number): Promise<string[]> {
  const values = await within(page.locator('input[type=password]').evaluateAll((inputs) => inputs.map((input) => (input as unknown as { value: string }).value)), ms);
  if (values === TIMED_OUT) throw new Error(`Timeout ${ms}ms exceeded while the password fields were read`);
  return values.filter((value) => value.length > 0);
}

// the longest value goes first, so a value that holds a shorter one is masked whole.
export const maskPasswords = (snapshot: string, secrets: string[]) =>
  [...secrets].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join('••••••'), snapshot);

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
  let tracing: string | undefined;
  let userAgent: string | undefined;
  let lastActivity = Date.now();

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
    if (closing) return;
    logger.warn('the browser stopped', { tasks: [...tasks.keys()] });
    for (const tab of tabs.values()) endRow(tab.id, 'crashed', 'the browser stopped', tab.id === tracing ? { error: 'the browser stopped before the trace was saved' } : {});
    tabs.clear();
    tasks.clear();
    tracing = undefined;
  };

  const ownTask = () => [...tasks.values()][0];

  async function launch(): Promise<BrowserContext> {
    if (profileBusy(profile)) throw new Error('profile busy');
    mkdirSync(downloads, { recursive: true });
    hardenProfile(profile, downloads);
    // no other chrome holds the profile, so no task row that is open can be live. the app crashed while it ran.
    sweep();
    const start = () =>
      chromium.launchPersistentContext(profile, {
        channel: 'chrome',
        headless: true,
        serviceWorkers: 'block',
        // no tool works with a file, and a download is a file that a page puts on this pc without a step.
        acceptDownloads: false,
        viewport: { width: 1280, height: 800 },
        args: deps.args ?? [],
        ...(userAgent ? { userAgent } : {}),
      });
    let ctx = await start();
    // headless chrome names itself HeadlessChrome in its user agent, and a search engine shows more captchas to it. the
    // first launch reads the name, and chrome starts once more with the name of normal chrome.
    if (!userAgent) {
      const agent = await (ctx.pages()[0] ?? (await ctx.newPage())).evaluate(() => navigator.userAgent);
      userAgent = agent.replace('HeadlessChrome/', 'Chrome/');
      if (userAgent !== agent) {
        await ctx.close();
        ctx = await start();
      }
    }
    ctx.on('close', onContextClosed);
    await guardContext(
      ctx,
      deps.egress,
      (page) => tabs.get(page)?.rules,
      (url) => {
        // a popup belongs to no tab. it is refused, and the open task records it.
        const task = ownTask();
        if (task) task.blocked.push({ url, reason: 'a new tab or window is refused. Use browser_open with its address' });
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
    const tab = { id: newId(), kind, sessionKey: step.sessionKey, page, allowlist: new Set(allowlist), submit: false, blocked: [], sent: [], console: [], lastUsed: Date.now(), queue: Promise.resolve(), snapshot: 0 } as unknown as Tab;
    tab.rules = {
      allows: (host) => allowedBy(tab.allowlist, host),
      submitting: () => tab.submit,
      onBlocked: (blocked, top) => {
        tab.blocked.push(blocked);
        if (top) tab.topBlocked = true;
      },
      // the route and the cdp layer both see the first request of a page, so one request comes here twice.
      onSent: (sent) => void (tab.sent.some((each) => each.method === sent.method && each.url === sent.url) || tab.sent.push(sent)),
    };
    page.setDefaultTimeout(t.action);
    page.setDefaultNavigationTimeout(t.navigation);
    page.on('crash', () => (tab.crashed = 'the page crashed'));
    page.on('console', (message) => message.type() === 'error' && tab.console.length < 20 && tab.console.push(message.text().slice(0, 300)));
    page.on('pageerror', (error) => tab.console.length < 20 && tab.console.push(error.message.slice(0, 300)));
    // the tab gets no address before both layers of the gate are in place.
    try {
      await guardTab(await ctx.newCDPSession(page), deps.egress, tab.rules);
    } catch (err) {
      await page.close().catch(() => undefined);
      throw err;
    }
    tabs.set(page, tab);
    db.prepare('INSERT INTO browser_tasks (id, kind, sessionKey, runId, allowlist, status, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      tab.id,
      kind,
      step.sessionKey,
      step.runId,
      JSON.stringify([...tab.allowlist]),
      'open',
      now(),
    );
    if (kind === 'task') {
      // the trace belongs to the context, so one task at a time has it. the row says why a task has no trace.
      try {
        if (tracing) throw new Error(`task ${tracing} still has the trace`);
        // a dom snapshot also turns on the network log of the trace, with the cookie of each request. the screenshots
        // and the action list stay, and each step keeps the masked snapshot that the model read.
        await ctx.tracing.start({ screenshots: true, snapshots: { dom: false, aria: false, screen: true }, title: tab.id });
        tracing = tab.id;
      } catch (err) {
        logger.warn('the browser trace did not start', { taskId: tab.id, err });
        db.prepare('UPDATE browser_tasks SET traceError = ? WHERE id = ?').run(`the trace did not start: ${errorText(err).split('\n')[0]}`, tab.id);
      }
    }
    return tab;
  }

  async function endTab(tab: Tab, status: 'closed' | 'crashed', reason: string): Promise<void> {
    tabs.delete(tab.page);
    if (tasks.get(tab.sessionKey) === tab) tasks.delete(tab.sessionKey);
    // the tab closes first. a hung page keeps its renderer busy, and with dom snapshots it also held the trace stop for
    // ever.
    await within(tab.page.close({ runBeforeUnload: false }), t.capture);
    let trace: { path?: string; bytes?: number; error?: string } = {};
    if (tracing === tab.id && context) {
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
             consoleErrors, blockedRequests, sent, error, durationMs, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          tab.id,
          step.runId,
          step.toolCallId ?? null,
          step.action,
          step.target === undefined ? null : redactedJson(step.target),
          data.urlBefore,
          data.urlAfter,
          snapshotBlob,
          screenshotBlob,
          tab.console.length ? redactedJson(tab.console) : null,
          tab.blocked.length ? redactedJson(tab.blocked) : null,
          tab.sent.length ? redactedJson(tab.sent) : null,
          data.error ?? null,
          Math.round(performance.now() - data.started),
          now(),
        );
      return Number(row!.id);
    } catch (err) {
      logger.error('browser step write failed', { taskId: tab.id, err });
      return undefined;
    }
  }

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
      tab.lastUsed = Date.now();
      lastActivity = Date.now();
      tab.blocked = [];
      tab.sent = [];
      tab.topBlocked = false;
      tab.console = [];
      const urlBefore = tab.page.url();
      let note = '';
      let error: string | undefined;
      let acted = true;
      try {
        note = (await action(tab.page)) ?? '';
      } catch (err) {
        error = errorText(err).split('\n')[0]!;
        acted = !(err instanceof NotDone);
      }
      // a navigation can still run. the snapshot waits for the document, with the capture limit.
      await tab.page.waitForLoadState('domcontentloaded', { timeout: t.capture }).catch(() => undefined);
      const stayed = await leaveErrorPage(tab, urlBefore);
      if (stayed) note = note ? `${note}. ${stayed}` : stayed;
      const shot = await capture(tab);
      const urlAfter = tab.page.url();
      if (!urlAfter.startsWith('chrome-error:')) tab.lastPage = urlAfter;
      const stepId = record(tab, input, { urlBefore, urlAfter, snapshot: shot.snapshot, jpeg: shot.jpeg, started, ...(error || shot.errors.length ? { error: [error, ...shot.errors].filter(Boolean).join('; ') } : {}) });
      const base = { url: urlAfter, blocked: [...tab.blocked], sent: [...tab.sent], taskId: tab.id, acted, ...(shot.snapshot !== undefined ? { snapshot: shot.snapshot } : {}), ...(stepId ? { stepId } : {}) };
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
    if (target && tab.page.url() !== target) await tab.page.goto(target, { waitUntil: 'domcontentloaded', timeout: t.capture }).catch(() => undefined);
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
    for (const tab of tasks.values()) if (Date.now() - tab.lastUsed > idleMs) void serial(tab, () => endTab(tab, 'closed', 'no browser action for a while'));
    if (context && !tabs.size && Date.now() - lastActivity > idleMs) {
      closing = true;
      const ctx = context;
      context = undefined;
      void ctx.close().finally(() => (closing = false));
    }
  }, Math.min(60_000, idleMs));
  timer.unref();

  return {
    async open(input, url) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return { refused: `${JSON.stringify(url)} is not a full web address.` };
      }
      let tab = tasks.get(input.sessionKey);
      if (tab && !allowedBy(tab.allowlist, host)) {
        return { refused: `${host} is not on the allowlist of this task (${[...tab.allowlist].join(', ')}). Use browser_allow_domain to ask the owner, or browser_close and start a new task.` };
      }
      if (!tab) {
        // the task of another session can wait for the owner to approve a submit, for hours, so it is never taken.
        const other = ownTask();
        if (other) {
          return { refused: `The browser is busy with a task of another session (${other.sessionKey}). That task ends after ${Math.round(idleMs / 60_000)} minutes without an action. Try again later.` };
        }
        const ctx = await contextOrRefusal();
        if ('refused' in ctx) return ctx;
        tab = await newTab(ctx, 'task', input, [siteOf(host)]);
        tasks.set(input.sessionKey, tab);
      }
      return step(tab, { ...input, target: url }, async (page) => {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        return response && response.status() >= 400 ? `the page answered with status ${response.status()}` : undefined;
      });
    },
    async act(input, action, scope = 'session') {
      const tab = scope === 'open' ? ownTask() : tasks.get(input.sessionKey);
      if (!tab) return { refused: `No page is open${scope === 'open' ? '' : ' in this session'}. Use browser_open first.` };
      return step(tab, input, (page) => action(page, { allowlist: tab.allowlist, snapshot: tab.snapshot, setSubmit: (on) => void (tab.submit = on) }));
    },
    async inTab(input, hosts, work) {
      const ctx = await contextOrRefusal();
      if ('refused' in ctx) return ctx;
      const tab = await newTab(ctx, 'search', input, hosts.map(siteOf));
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
    },
  };
}
