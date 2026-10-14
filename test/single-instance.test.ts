import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { holdInstanceLock } from '../src/instance.js';
import { createAutomation } from '../src/scheduler/store.js';
import { createTestApp } from './app-harness.js';

// main runs in its own process with an empty working folder. without secrets it stops at the model setup, so it never
// reaches a real service.
function startMain(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|TELEGRAM|OPENAI/i.test(name)));
  const main = join(import.meta.dirname, '..', 'src', 'main.ts');
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), main, ...args], { cwd, env, encoding: 'utf8', timeout: 50_000 });
  const logs = join(cwd, 'data', 'logs');
  const log = readdirSync(logs).map((name) => readFileSync(join(logs, name), 'utf8')).join('');
  return { code: result.status, log };
}

// each case starts node with tsx one or two times, which takes seconds while the other test files run.
describe('one service for each data folder', { timeout: 60_000 }, () => {
  it('stops a second service on the same data folder before it opens the database', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'okc-main-'));
    const lock = await holdInstanceLock(join(cwd, 'data'));
    try {
      const second = startMain(cwd);
      expect(second.code).toBe(1);
      expect(second.log).toContain('another ok computer process runs on the data folder');
      expect(second.log).not.toContain('model setup failed');
    } finally {
      await lock!.release();
    }
    // without the other process, the start goes on to the model setup.
    expect(startMain(cwd).log).toContain('model setup failed');
  });

  it('lets npm run chat start next to the service', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'okc-main-'));
    const lock = await holdInstanceLock(join(cwd, 'data'));
    try {
      const chat = startMain(cwd, '--chat');
      expect(chat.log).not.toContain('another ok computer process');
      expect(chat.log).toContain('model setup failed');
    } finally {
      await lock!.release();
    }
  });
});

// a chat process that claimed a reminder sent it to its own terminal, and the owner never saw it.
describe('the scheduler of npm run chat', () => {
  it('runs no due job in the chat process, and the service runs it', async () => {
    const start = '2026-10-12T21:00:00-07:00';
    const db = openDb(':memory:');
    const created = createAutomation(
      db,
      { name: 'goals: reminder 21:00', schedule: { kind: 'every', everyMs: 60 * 60_000 }, payload: { type: 'system_event', text: 'set your goals' }, sessionMode: 'main', createdBy: 'system' },
      new Date('2026-10-12T19:30:00-07:00'),
      'America/Los_Angeles',
    );
    if (!created.ok) throw new Error(created.error);
    const due = created.value.nextRunAt;
    const runs = () => db.prepare('SELECT status FROM automation_runs').all();

    const chat = createTestApp([], { start, deps: { db, background: false } });
    await chat.app.start();
    await chat.settle();
    expect(runs()).toEqual([]);
    expect(db.prepare('SELECT nextRunAt FROM automations WHERE id = ?').get(created.value.id)).toEqual({ nextRunAt: due });
    await chat.app.stop();

    const service = createTestApp([], { start, deps: { db } });
    await service.app.start();
    await service.settle();
    expect(runs()).toEqual([{ status: 'completed' }]);
    await service.app.stop();
  });
});
