// screenshots of the web app against the seeded test database, for a visual check at the two widths that each view
// supports. build the web app first (npx vite build web), then run from the root of the repo:
//
//   npx tsx web/scripts/shots.ts <shots.json> <out dir> [name filter]
//
// shots.json is an array of { name, hash, width, dark?, devMode?, click?, keys?, wait?, stubs?, height? }:
// - check each view at width 1440 and at width 390. a width under 500 uses a scale of 2.
// - click is a playwright selector that the script clicks after the page loads. keys is a key press after it, for
//   example Meta+k.
// - wait is the selector to wait for. the default is the page title in the main area.
// - height sets the height of the window, for a page that is longer than the default window. the main area scrolls
//   inside the shell, so a full-page shot of the document would not show more.
// - stubs maps "GET /api/path" to a json body, for an endpoint that is not built yet. the path has no query. a value
//   of the form { "$status": 500, "$body": {...} } answers with that status, for a shot of an error state.
// the script uses the chrome of the system, and prints each page error, each console error and each page that
// scrolls sideways. the out dir goes under explorations/, which git ignores.
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright-core';
import { seedDashboard } from '../../test/seed.js';

type Shot = {
  name: string;
  hash: string;
  width: number;
  dark?: boolean;
  devMode?: boolean;
  click?: string;
  keys?: string;
  wait?: string;
  stubs?: Record<string, unknown>;
  height?: number;
};

// a stub with a status other than 200 wraps its body, so that a plain body with a field named status stays a body.
function statusStub(value: unknown): value is { $status: number; $body: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { $status?: unknown }).$status === 'number';
}

const [spec, out, only] = process.argv.slice(2) as [string, string, string | undefined];
const shots = JSON.parse(readFileSync(spec, 'utf8')) as Shot[];
mkdirSync(out, { recursive: true });
const seeded = await seedDashboard({ webDir: resolve(import.meta.dirname, '../dist') });
const server = serve({ fetch: seeded.dashboard.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((done) => server.once('listening', done));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
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
  for (const [key, value] of Object.entries(shot.stubs ?? {})) {
    const [method, path] = key.split(' ', 2) as [string, string];
    const answer = statusStub(value) ? { status: value.$status, json: value.$body } : { json: value };
    await page.route(
      (url) => url.pathname === path,
      (route) => (route.request().method() === method ? route.fulfill(answer) : route.fallback()),
    );
  }
  page.on('pageerror', (err) => console.log(`${shot.name}: page error ${err.message}`));
  page.on('console', (message) => message.type() === 'error' && console.log(`${shot.name}: console ${message.text()}`));
  await page.goto(`${base}${shot.hash}`);
  await page.locator(shot.wait ?? 'main .page-title').first().waitFor();
  await page.waitForTimeout(700);
  if (shot.click) await page.locator(shot.click).first().click();
  if (shot.keys) await page.keyboard.press(shot.keys);
  if (shot.click || shot.keys) await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${shot.name}.png`) });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) console.log(`${shot.name}: the page scrolls sideways by ${overflow}px`);
  await context.close();
}

await browser.close();
server.close();
await seeded.t.app.stop();
console.log(`done, the shots are in ${out}`);
process.exit(0);
