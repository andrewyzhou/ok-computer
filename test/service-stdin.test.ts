import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// okc.sh and the login agent of macos start the agent with /dev/null as stdin. without telegram the cli channel saw
// the end of its input at once, and the agent stopped with code 0, which launchd does not restart. main runs here in
// its own process with a config in an empty folder. the model address is a closed local port, so nothing reaches a
// real service, and no run starts in these cases.

const SLOTS = ['main', 'heartbeat', 'utility', 'batch', 'consolidation', 'compaction'];
const children: ChildProcess[] = [];
const folders: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

async function startMain(env: NodeJS.ProcessEnv) {
  const cwd = mkdtempSync(join(tmpdir(), 'okc-service-'));
  folders.push(cwd);
  const port = await freePort();
  const slots = Object.fromEntries(SLOTS.map((slot) => [slot, { chain: ['openai-compat/test-model'] }]));
  writeFileSync(join(cwd, 'okc.config.json'), JSON.stringify({ slots, heartbeat: { every: '0' }, dashboard: { port } }));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|TELEGRAM|OPENAI|OKC_/i.test(name)));
  const main = join(import.meta.dirname, '..', 'src', 'main.ts');
  // stdin is /dev/null, as with nohup </dev/null and under launchd.
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), main], {
    cwd,
    env: { ...clean, OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:9/v1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let exitCode: number | null | undefined;
  child.once('exit', (code) => (exitCode = code));
  const answers = async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/api/overview`);
      return true;
    } catch {
      return false;
    }
  };
  return { child, answers, exited: () => exitCode !== undefined, exitCode: () => exitCode };
}

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the agent as a service with /dev/null as stdin', { timeout: 60_000 }, () => {
  it('keeps running without telegram when OKC_SERVICE is 1', async () => {
    const agent = await startMain({ OKC_SERVICE: '1' });
    await expect.poll(agent.answers, { timeout: 40_000, interval: 200 }).toBe(true);
    await new Promise((done) => setTimeout(done, 3_000));
    expect(agent.exited()).toBe(false);
    agent.child.kill('SIGTERM');
    await expect.poll(agent.exited, { timeout: 15_000 }).toBe(true);
    expect(agent.exitCode()).toBe(0);
  });

  // this is the case that the service variable fixes: a start from a terminal with ended input still stops.
  it('stops by itself without the variable, because the cli input ended', async () => {
    const agent = await startMain({});
    await expect.poll(agent.exited, { timeout: 40_000, interval: 200 }).toBe(true);
    expect(agent.exitCode()).toBe(0);
  });
});
