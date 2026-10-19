import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { openDb } from '../src/db/index.js';
import { findChrome } from '../src/browser/login.js';
import { createBrowserTools } from '../src/browser/tools.js';
import { createBrowserWorker, type BrowserDeps } from '../src/browser/worker.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { createByteStore } from '../src/observability/byte-blobs.js';
import { silentLogger } from '../src/observability/logger.js';
import type { ToolContext } from '../src/tools/registry.js';
import { fixtureEgress } from './web-fixture.js';

// the browser tests need the installed chrome. they skip without it, like the docker tests.
export const hasChrome = () => findChrome() !== undefined;

// a server on 127.0.0.5 stands for the owner's network. linux and windows answer on every 127.x address, and macos
// answers only on 127.0.0.1 until the owner adds an alias with "sudo ifconfig lo0 alias 127.0.0.5 up". the tests
// that need the address skip without it.
export const LAN_ADDRESS = '127.0.0.5';
export const hasLanAddress = await new Promise<boolean>((done) => {
  const server = createServer();
  server.once('error', () => done(false));
  server.listen(0, LAN_ADDRESS, () => server.close(() => done(true)));
});

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

// the entries of a trace zip with their bytes. windows and the unzip of macos and linux expand the zip, so the test
// needs no zip library.
export function traceEntries(zip: string): Map<string, Buffer> {
  const out = mkdtempSync(join(tmpdir(), 'okc-trace-'));
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}'`]);
  } else {
    execFileSync('unzip', ['-q', zip, '-d', out]);
  }
  const entries = new Map<string, Buffer>();
  for (const name of readdirSync(out, { recursive: true, withFileTypes: true })) {
    const path = join(name.parentPath, name.name);
    if (name.isFile()) entries.set(path.slice(out.length + 1).split(sep).join('/'), readFileSync(path));
  }
  return entries;
}

// a crash of chrome: every chrome process of the profile ends at once.
export function killChrome(profileDir: string): number {
  const name = profileDir.split(/[\\/]/).pop()!;
  if (process.platform !== 'win32') {
    // pgrep exits with 1 when no process matches.
    const found = spawnSync('pgrep', ['-f', '--', `--user-data-dir=[^ ]*${name}`], { encoding: 'utf8' }).stdout;
    const pids = found.split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // the process ended already.
      }
    }
    return pids.length;
  }
  const out = execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${name}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
  ]).toString();
  return out.split(/\s+/).filter(Boolean).length;
}
