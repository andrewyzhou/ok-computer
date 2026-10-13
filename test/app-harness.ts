import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createApp, type AppDeps } from '../src/app.js';
import { createCliChannel } from '../src/channels/cli.js';
import { parseConfig } from '../src/config/load.js';
import { openDb } from '../src/db/index.js';
import { createFakeClient, type FakeStep } from '../src/models/fake.js';
import { silentLogger } from '../src/observability/logger.js';

// the harness runs the whole app with a fake model, an in-memory cli, and a clock that only the test moves.
export function createTestApp(steps: FakeStep[], options: { start: string; config?: Record<string, unknown>; deps?: Partial<AppDeps> }) {
  const workspace = mkdtempSync(join(tmpdir(), 'okc-app-'));
  writeFileSync(join(workspace, 'USER.md'), 'The owner likes short answers.');
  const dataDir = join(workspace, 'data');
  const parsed = parseConfig({
    slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] } },
    pricing: { 'fake/m': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } },
    paths: { workspace, data: dataDir },
    ...options.config,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const db = options.deps?.db ?? openDb(':memory:');
  const model = createFakeClient(steps);
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  let now = new Date(options.start);
  const clock = () => now;
  let ids = 0;
  const app = createApp({
    config: parsed.value,
    db,
    logger: silentLogger,
    clients: { fake: model },
    channels: [createCliChannel({ input, output, clock })],
    clock,
    setTimer: () => () => {},
    newId: () => `run-${++ids}`,
    ...options.deps,
  });
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await app.idle();
  };
  return {
    app,
    db,
    model,
    dataDir,
    clock,
    config: parsed.value,
    printed: () => printed,
    async say(line: string) {
      input.write(line + '\n');
      await settle();
    },
    // type sends a line and does not wait for the run to end.
    async type(line: string) {
      input.write(line + '\n');
      await new Promise((resolve) => setImmediate(resolve));
    },
    // at moves the clock and runs every automation that is due.
    async at(iso: string) {
      now = new Date(iso);
      await app.scheduler.tick();
      await settle();
    },
    // tick moves the clock and runs the due automations, but it does not wait for the queued runs.
    async tick(iso: string) {
      now = new Date(iso);
      await app.scheduler.tick();
    },
    settle,
    rows: (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params),
  };
}
