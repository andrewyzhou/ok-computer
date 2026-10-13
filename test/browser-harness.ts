import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { createBrowserTools } from '../src/browser/tools.js';
import { createBrowserWorker, type BrowserDeps } from '../src/browser/worker.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { createByteStore } from '../src/observability/byte-blobs.js';
import { silentLogger } from '../src/observability/logger.js';
import type { ToolContext } from '../src/tools/registry.js';
import { fixtureEgress } from './web-fixture.js';

// the browser tests need the installed chrome. they skip without it, like the docker tests.
export const hasChrome = () =>
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ].some((path) => existsSync(path));

// chrome resolves the *.test names to the fixture itself. the gate resolves them with the fixture egress.
export const FIXTURE_ARGS = ['--host-resolver-rules=MAP *.test 127.0.0.1'];

export function createBrowserHarness(extra: Partial<BrowserDeps> = {}) {
  const dir = extra.dir ?? mkdtempSync(join(tmpdir(), 'okc-browser-'));
  const db = extra.db ?? openDb(':memory:');
  const clock = () => new Date();
  const blobs = createBlobStore(db, join(dir, 'blobs'), clock);
  const bytes = createByteStore(db, join(dir, 'blobs'), clock);
  let ids = 0;
  const worker = createBrowserWorker({
    db,
    blobs,
    bytes,
    logger: silentLogger,
    clock,
    dir,
    egress: fixtureEgress(),
    enabled: true,
    args: FIXTURE_ARGS,
    newId: () => `task-${++ids}`,
    timeouts: { action: 3000, navigation: 5000, capture: 2000 },
    ...extra,
  });
  const tools = new Map(createBrowserTools(worker).map((tool) => [tool.name, tool]));
  let calls = 0;
  const ctx = (sessionKey = 'main'): ToolContext => ({ runId: 'run-1', sessionKey, timeZone: 'UTC', clock, signal: new AbortController().signal, toolCallId: `call-${++calls}` });
  return {
    dir,
    db,
    blobs,
    bytes,
    worker,
    run: (name: string, input: unknown, sessionKey?: string) => tools.get(name)!.run(input, ctx(sessionKey)),
    steps: () => db.prepare('SELECT * FROM browser_steps ORDER BY id').all(),
    tasks: () => db.prepare('SELECT * FROM browser_tasks ORDER BY startedAt, id').all(),
  };
}

// a crash of chrome: every chrome process of the profile ends at once.
export function killChrome(profileDir: string): number {
  const name = profileDir.split(/[\\/]/).pop()!;
  const out = execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${name}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
  ]).toString();
  return out.split(/\s+/).filter(Boolean).length;
}
