// screenshots of the web app against the seeded test database, for a visual check at the two widths that each view
// supports. build the web app first (npx vite build web), then run from the root of the repo:
//
//   npx tsx web/scripts/shots.ts <shots.json> <out dir> [name filter]
//
// shots.json is an array of { name, hash, width, dark?, devMode?, seed?, click?, keys?, wait?, stubs?, stubsOf?, height? }:
// - check each state at width 1440 and at width 390, each in light and in dark. a width under 500 uses a scale of 2.
// - seed picks the seeded database that the shot runs against. dashboard (the default) is test/seed.ts. people is
//   test/seed-people.ts, inbox is test/seed-inbox.ts, and today is test/seed-today.ts with the proposal of its week.
//   each seed runs its own server, which starts at the first shot that names it. the seeds other than dashboard serve
//   web/dist, as the dashboard does by default.
// - click is a playwright selector that the script clicks after the page loads. the two layouts often have different
//   parts, so a shot at 390 and a shot at 1440 may need different selectors. a click that finds nothing within 5
//   seconds is printed, and the shot is taken anyway. keys is a key press after it, for example Meta+k. scroll is a
//   selector that the script scrolls into view, for a part far down a long page.
// - wait is the selector to wait for. the default is the page title in the main area.
// - height sets the height of the window, for a page that is longer than the default window. the main area scrolls
//   inside the shell, so a full-page shot of the document would not show more.
// - stubs maps "GET /api/path" to a json body, for an endpoint that is not built yet. the path has no query. a value
//   of the form { "$status": 500, "$body": {...} } answers with that status, for a shot of an error state. stubsOf
//   names another shot of the file whose stubs this shot takes, so the four variants of a state share one copy.
// the script uses the chrome of the system, and prints each page error, each console error and each page that
// scrolls sideways. the out dir goes under explorations/, which git ignores.
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright-core';
import { createDashboard } from '../../src/dashboard/server.js';
import { googleConfigSchema } from '../../src/google/config.js';
import { silentLogger } from '../../src/observability/logger.js';
import { createTestApp } from '../../test/app-harness.js';
import { seedDashboard } from '../../test/seed.js';
import { seedInbox } from '../../test/seed-inbox.js';
import { PEOPLE_ACCOUNTS, PEOPLE_NOW, seedPeople } from '../../test/seed-people.js';
import { seedToday } from '../../test/seed-today.js';

type SeedName = 'dashboard' | 'people' | 'inbox' | 'today';

type Shot = {
  name: string;
  hash: string;
  width: number;
  dark?: boolean;
  devMode?: boolean;
  seed?: SeedName;
  click?: string;
  keys?: string;
  scroll?: string;
  wait?: string;
  stubs?: Record<string, unknown>;
  stubsOf?: string;
  height?: number;
};

// a stub with a status other than 200 wraps its body, so that a plain body with a field named status stays a body.
function statusStub(value: unknown): value is { $status: number; $body: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { $status?: unknown }).$status === 'number';
}

const [spec, out, only] = process.argv.slice(2) as [string, string, string | undefined];
const shots = JSON.parse(readFileSync(spec, 'utf8')) as Shot[];
mkdirSync(out, { recursive: true });
const webDir = resolve(import.meta.dirname, '../dist');

type Seeded = { fetch: (request: Request) => Response | Promise<Response>; close: () => unknown };

// the people routes on test/seed-people.ts, with the google block that the people page needs.
function seedPeopleDashboard(): Seeded {
  const t = createTestApp([], { start: PEOPLE_NOW.toISOString() });
  seedPeople(t.db);
  const google = googleConfigSchema.parse({ clientId: 'seed.apps.googleusercontent.com', accounts: PEOPLE_ACCOUNTS.map((alias) => ({ alias })) });
  const dashboard = createDashboard({ db: t.db, config: { ...t.config, google }, clock: () => PEOPLE_NOW, logger: silentLogger, app: t.app, webDir });
  return { fetch: dashboard.fetch, close: () => t.db.close() };
}

async function openSeed(name: SeedName): Promise<Seeded> {
  if (name === 'people') return seedPeopleDashboard();
  if (name === 'inbox') {
    const seeded = seedInbox();
    return { fetch: seeded.dashboard.fetch, close: seeded.close };
  }
  if (name === 'today') {
    const seeded = seedToday({ proposal: true });
    return { fetch: seeded.dashboard.fetch, close: seeded.close };
  }
  const seeded = await seedDashboard({ webDir });
  return { fetch: seeded.dashboard.fetch, close: () => seeded.t.app.stop() };
}

// the base url of each seed that a shot used, and the steps that stop them at the end.
const bases = new Map<SeedName, string>();
const closers: Array<() => unknown> = [];
async function baseOf(name: SeedName): Promise<string> {
  const known = bases.get(name);
  if (known) return known;
  const seeded = await openSeed(name);
  const server = serve({ fetch: seeded.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  bases.set(name, base);
  closers.push(async () => {
    server.close();
    await seeded.close();
  });
  return base;
}

// the chrome channel finds the installed chrome on each system, as the browser worker of the app does. CHROME_PATH
// names another build, for example a chromium.
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true });

for (const shot of shots.filter((each) => !only || each.name.includes(only))) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height ?? (shot.width < 500 ? 844 : 900) },
    deviceScaleFactor: shot.width < 500 ? 2 : 1,
    colorScheme: shot.dark ? 'dark' : 'light',
  });
  if (shot.devMode) await context.addInitScript(() => localStorage.setItem('okc.prefs', JSON.stringify({ devMode: true })));
  const page = await context.newPage();
  const stubs = shot.stubs ?? (shot.stubsOf === undefined ? {} : shots.find((each) => each.name === shot.stubsOf)?.stubs);
  if (!stubs) throw new Error(`${shot.name}: no shot named ${shot.stubsOf} has stubs`);
  for (const [key, value] of Object.entries(stubs)) {
    const [method, path] = key.split(' ', 2) as [string, string];
    const answer = statusStub(value) ? { status: value.$status, json: value.$body } : { json: value };
    await page.route(
      (url) => url.pathname === path,
      (route) => (route.request().method() === method ? route.fulfill(answer) : route.fallback()),
    );
  }
  page.on('pageerror', (err) => console.log(`${shot.name}: page error ${err.message}`));
  page.on('console', (message) => message.type() === 'error' && console.log(`${shot.name}: console ${message.text()}`));
  await page.goto(`${await baseOf(shot.seed ?? 'dashboard')}${shot.hash}`);
  await page.locator(shot.wait ?? 'main .page-title').first().waitFor();
  await page.waitForTimeout(700);
  if (shot.click) {
    // a selector of the other layout finds nothing. the shot would then show the state before the click, so the
    // script says so.
    await page
      .locator(shot.click)
      .first()
      .click({ timeout: 5000 })
      .catch(() => console.log(`${shot.name}: the click found nothing for ${shot.click}`));
  }
  if (shot.keys) await page.keyboard.press(shot.keys);
  if (shot.scroll) await page.locator(shot.scroll).first().scrollIntoViewIfNeeded();
  if (shot.click || shot.keys || shot.scroll) await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${shot.name}.png`) });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) console.log(`${shot.name}: the page scrolls sideways by ${overflow}px`);
  await context.close();
}

await browser.close();
for (const close of closers) await close();
console.log(`done, the shots are in ${out}`);
process.exit(0);
