import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { createBlobStore } from '../observability/blobs.js';
import { createByteStore } from '../observability/byte-blobs.js';
import { silentLogger } from '../observability/logger.js';
import type { ToolContext } from '../tools/registry.js';
import type { SandboxExecInput } from './input.js';
import { MAX_RUNNING } from './limits.js';
import { createSandboxExecTool } from './tool.js';
import type { ExecRequest, ExecResult, NetworkGate, NetworkPlan, Runner } from './types.js';

// the tool with the real file handling and allowlist check, and fakes only for docker: the runner, the scratch volume
// and the network gate. each test tries a failure path and checks that the slot and the trace row stay right.

const clock = () => new Date('2026-10-18T10:00:00Z');

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  status: 'ok',
  exitCode: 0,
  stdout: Buffer.from('done\n'),
  stderr: Buffer.alloc(0),
  stdoutBytes: 5,
  stderrBytes: 0,
  truncated: false,
  collected: [],
  notCollected: [],
  containerId: 'c',
  imageId: 'sha256:x',
  durationMs: 10,
  error: null,
  scratchBytes: 0,
  ...over,
});

function setup(over: { run?: Runner['run']; network?: Partial<NetworkGate>; volumeFor?: () => Promise<{ taskId: string; volume: string }> } = {}) {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'okc-sandbox-tool-edge-'));
  const stores = { blobs: createBlobStore(db, join(dir, 'blobs'), clock), bytes: createByteStore(db, join(dir, 'blobs'), clock) };
  const live = new Set<number>();
  const run = vi.fn(over.run ?? (async () => ok()));
  const plan: NetworkPlan = { networkMode: 'n', env: [], extraHosts: [], passed: () => [], refused: () => [], close: async () => {} };
  const network: NetworkGate = { check: async () => ({ ok: true }), open: async () => plan, ...over.network };
  const tool = createSandboxExecTool({
    db,
    stores,
    runner: { run },
    scratch: { volumeFor: over.volumeFor ?? (async () => ({ taskId: 't', volume: 'v' })), afterExec: async () => ({ reset: false }), sweep: async () => 0 },
    network,
    logger: silentLogger,
    clock,
    image: 'okc-sandbox:1',
    probe: () => ({ available: true, reason: null, engine: 'docker 28', imageId: 'sha256:x' }),
    live,
  });
  const ctx = (toolCallId = 'c1', signal = new AbortController().signal): ToolContext => ({ runId: 'run-1', sessionKey: 'main', timeZone: 'UTC', clock, signal, toolCallId });
  const call = (input: SandboxExecInput, context = ctx()) => tool.run(tool.input.parse(input), context);
  const rows = () => db.prepare('SELECT id, runId, toolCallId, status, error, network, allowlist FROM sandbox_execs ORDER BY id').all();
  return { db, stores, live, run, tool, ctx, call, rows };
}

describe('sandbox_exec on its failure paths', () => {
  it('frees the slot after many refused calls at once', async () => {
    const t = setup();
    const refused = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        t.call(i % 2 ? { language: 'bash', code: 'ls', network: { allow: ['com'] } } : { language: 'bash', code: 'ls', files: [{ path: 'a/../b', content: 'x' }] }),
      ),
    );
    for (const out of refused) expect(out).toMatchObject({ isError: true, effect: 'none' });
    expect(t.rows()).toEqual([]);
    expect(t.run).not.toHaveBeenCalled();
    const outs = await Promise.all(Array.from({ length: MAX_RUNNING }, () => t.call({ language: 'bash', code: 'ls' })));
    for (const out of outs) expect(out.isError).toBeUndefined();
  });

  it('refuses a blob that the store does not have before it writes a row', async () => {
    const t = setup();
    const out = await t.call({ language: 'bash', code: 'cat a', files: [{ path: 'a', blob: 'a'.repeat(64) }] });
    expect(out).toMatchObject({ isError: true, effect: 'none' });
    expect(out.content).toContain('no file has the blob');
    expect(t.rows()).toEqual([]);
  });

  it('refuses a collect path with an empty segment or the reserved folder', async () => {
    const t = setup();
    for (const path of ['out//a', 'out/', '.okc/secret', 'a/./b']) {
      const out = await t.call({ language: 'bash', code: 'ls', collect: [path] });
      expect(out, path).toMatchObject({ isError: true, effect: 'none' });
    }
    expect(t.rows()).toEqual([]);
  });

  it('says so and writes no row when the network mode does not work here', async () => {
    const t = setup({ network: { check: async () => ({ ok: false, reason: 'the docker0 bridge was not found' }) } });
    const out = await t.call({ language: 'bash', code: 'curl https://pypi.org', network: { allow: ['pypi.org'] } });
    expect(out).toMatchObject({ isError: true, effect: 'none' });
    expect(out.content).toContain('docker0 bridge');
    expect(t.rows()).toEqual([]);
  });

  it('writes no row and frees the slot when the scratch volume cannot be made', async () => {
    const t = setup({ volumeFor: async () => Promise.reject(new Error('volume driver gone')) });
    for (let i = 0; i < MAX_RUNNING + 1; i++) {
      const out = await t.call({ language: 'bash', code: 'ls' });
      expect(out).toMatchObject({ isError: true, effect: 'none' });
      expect(out.content).toContain('volume driver gone');
    }
    expect(t.rows()).toEqual([]);
    expect(t.live.size).toBe(0);
  });

  it('closes the row with the reason when the network cannot open, and frees the slot', async () => {
    const t = setup({ network: { open: async () => Promise.reject(new Error('the relay did not start')) } });
    for (let i = 0; i < MAX_RUNNING + 1; i++) {
      const out = await t.call({ language: 'python', code: 'print(1)', network: { allow: ['pypi.org'] } }, t.ctx(`c${i}`));
      expect(out).toMatchObject({ isError: true, effect: 'none' });
    }
    expect(t.live.size).toBe(0);
    expect(t.rows()).toHaveLength(MAX_RUNNING + 1);
    for (const row of t.rows() as Array<{ status: string; error: string; network: string; allowlist: string }>) {
      expect(row).toMatchObject({ status: 'error', error: 'the relay did not start', network: 'allowlist', allowlist: '["pypi.org"]' });
    }
    expect(t.run).not.toHaveBeenCalled();
  });

  it('links each row to its run and tool call, also for two calls at once', async () => {
    const t = setup();
    await Promise.all([t.call({ language: 'bash', code: 'a' }, t.ctx('call-a')), t.call({ language: 'node', code: 'b' }, t.ctx('call-b'))]);
    const rows = t.rows() as Array<{ runId: string; toolCallId: string; status: string }>;
    expect(rows.map((row) => [row.runId, row.toolCallId, row.status]).sort()).toEqual([
      ['run-1', 'call-a', 'ok'],
      ['run-1', 'call-b', 'ok'],
    ]);
  });

  it('gives the original text of a file to the container and its row to the trace', async () => {
    let seen: ExecRequest | undefined;
    const t = setup({
      run: async (request) => {
        seen = request;
        return ok();
      },
    });
    await t.call({ language: 'python', code: 'open("data/in.csv").read()', files: [{ path: 'data/in.csv', content: 'a,b\n1,2\n' }] });
    expect(seen?.files).toEqual([{ path: 'data/in.csv', bytes: Buffer.from('a,b\n1,2\n') }]);
    const files = t.db.prepare('SELECT direction, path, size, mime FROM sandbox_files').all();
    expect(files).toEqual([{ direction: 'in', path: 'data/in.csv', size: 8, mime: 'text/csv; charset=utf-8' }]);
  });

  it('keeps a binary collected file in the byte store with its exact bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const t = setup({ run: async () => ok({ collected: [{ path: 'plot.png', bytes }] }) });
    const out = await t.call({ language: 'python', code: 'plot()', collect: ['plot.png'] });
    const row = t.db.prepare("SELECT blob, size, mime FROM sandbox_files WHERE direction = 'out'").get() as { blob: string; size: number; mime: string };
    expect(row).toMatchObject({ size: bytes.length, mime: 'image/png' });
    expect(t.stores.bytes.read(row.blob)?.bytes.equals(bytes)).toBe(true);
    expect(out.content).toContain(`plot.png (image/png, ${bytes.length} bytes): blob ${row.blob}`);
  });

  it('says that the output was cut and gives the counts', async () => {
    const t = setup({
      run: async () => ok({ stdout: Buffer.from('x'.repeat(10)), stdoutBytes: 5_000_000, stderr: Buffer.from('e'), stderrBytes: 1, truncated: true }),
    });
    const out = await t.call({ language: 'bash', code: 'yes' });
    expect(out.content).toContain('stdout (5000000 bytes, cut to 10):');
    expect(out.content).toContain('stderr (1 bytes):');
    const row = t.db.prepare('SELECT stdoutBytes, stderrBytes, truncated FROM sandbox_execs').get();
    expect(row).toEqual({ stdoutBytes: 5_000_000, stderrBytes: 1, truncated: 1 });
  });

  it('gives a failed exit as an error with the exit code and keeps both streams', async () => {
    const t = setup({ run: async () => ok({ status: 'failed', exitCode: 3, stderr: Buffer.from('boom'), stderrBytes: 4 }) });
    const out = await t.call({ language: 'bash', code: 'exit 3' });
    expect(out.isError).toBe(true);
    // the command ran, so its effect is not none.
    expect(out.effect).toBeUndefined();
    expect(out.content).toMatch(/^Exit code 3 \(failed\)/);
    expect(out.content).toContain('boom');
    expect(t.db.prepare('SELECT status, exitCode FROM sandbox_execs').get()).toEqual({ status: 'failed', exitCode: 3 });
  });

  it('frees the slot of the exec when the file rows cannot be written', async () => {
    const db = openDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'okc-sandbox-f4-'));
    const stores = { blobs: createBlobStore(db, join(dir, 'blobs'), clock), bytes: createByteStore(db, join(dir, 'blobs'), clock) };
    const live = new Set<number>();
    const tool = createSandboxExecTool({
      db, stores,
      runner: { run: async () => ok() },
      scratch: { volumeFor: async () => ({ taskId: 't', volume: 'v' }), afterExec: async () => ({ reset: false }), sweep: async () => 0 },
      network: { check: async () => ({ ok: true }), open: async () => Promise.reject(new Error('no')) },
      logger: silentLogger, clock, image: 'okc-sandbox:1',
      probe: () => ({ available: true, reason: null, engine: 'docker 28', imageId: 'sha256:x' }),
      live,
    });
    const ctx = { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock, signal: new AbortController().signal, toolCallId: 'c1' };
    db.exec("CREATE TRIGGER fail_files BEFORE INSERT ON sandbox_files BEGIN SELECT RAISE(ABORT, 'the disk is full'); END");
    for (let i = 0; i < 2; i++) {
      const out = await tool.run(tool.input.parse({ language: 'bash', code: 'cat a.txt', files: [{ path: 'a.txt', content: 'x' }] }), ctx);
      expect(out.isError).toBe(true);
    }
    db.exec('DROP TRIGGER fail_files');
    expect(live.size).toBe(0);
    const out = await tool.run(tool.input.parse({ language: 'bash', code: 'echo hi' }), ctx);
    expect(out.isError).toBeUndefined();
  });
});

describe('sandbox_exec and the blobs of other places', () => {
  it('refuses a blob that no sandbox file names, such as a screenshot of another session', async () => {
    const t = setup();
    const hash = t.stores.bytes.put(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
    const out = await t.call({ language: 'bash', code: 'ls', files: [{ path: 'shot.png', blob: hash }] });
    expect(out).toMatchObject({ isError: true, effect: 'none' });
    expect(out.content).toContain('in the sandbox');
    expect(t.run).not.toHaveBeenCalled();
  });

  it('takes an output of an earlier call, and marks the result untrusted when that call had network access', async () => {
    const t = setup({ run: async () => ok({ collected: [{ path: 'page.html', bytes: Buffer.from('<p>from outside</p>') }] }) });
    const first = await t.call({ language: 'bash', code: 'curl -o page.html https://pypi.org', network: { allow: ['pypi.org'] }, collect: ['page.html'] });
    const hash = /blob ([0-9a-f]{64})/.exec(first.content)![1]!;
    const second = await t.call({ language: 'bash', code: 'cat page.html', files: [{ path: 'page.html', blob: hash }] });
    expect(second.isError).toBeUndefined();
    expect(second.untrustedSource).toMatch(/network access/);
    const clean = setup({ run: async () => ok({ collected: [{ path: 'a.txt', bytes: Buffer.from('mine') }] }) });
    const made = await clean.call({ language: 'bash', code: 'echo mine > a.txt', collect: ['a.txt'] });
    const own = /blob ([0-9a-f]{64})/.exec(made.content)![1]!;
    const again = await clean.call({ language: 'bash', code: 'cat a.txt', files: [{ path: 'a.txt', blob: own }] });
    expect(again.isError).toBeUndefined();
    expect(again.untrustedSource).toBeUndefined();
  });

  it('keeps the egress and the missed collect paths in the row', async () => {
    const plan: NetworkPlan = {
      networkMode: 'n',
      env: [],
      extraHosts: [],
      passed: () => ['pypi.org'],
      refused: () => [{ target: 'evil.test:443', reason: 'evil.test is not in the allowlist of this call' }],
      close: async () => {},
    };
    const t = setup({ network: { open: async () => plan }, run: async () => ok({ notCollected: [{ path: 'gone.csv', reason: 'no such file in /work' }] }) });
    await t.call({ language: 'bash', code: 'curl https://pypi.org', network: { allow: ['pypi.org'] }, collect: ['gone.csv'] });
    const row = t.db.prepare('SELECT egress, notCollected FROM sandbox_execs').get() as { egress: string; notCollected: string };
    expect(JSON.parse(row.egress)).toEqual({ passed: ['pypi.org'], refused: [{ target: 'evil.test:443', reason: 'evil.test is not in the allowlist of this call' }] });
    expect(JSON.parse(row.notCollected)).toEqual([{ path: 'gone.csv', reason: 'no such file in /work' }]);
  });

  it('ends a running exec when the app stops it, and frees its slot', async () => {
    const db = openDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'okc-sandbox-stop-'));
    const stores = { blobs: createBlobStore(db, join(dir, 'blobs'), clock), bytes: createByteStore(db, join(dir, 'blobs'), clock) };
    const live = new Set<number>();
    const running = new Map<number, { stop: AbortController; done: Promise<unknown> }>();
    const tool = createSandboxExecTool({
      db,
      stores,
      runner: {
        run: (request) => new Promise((resolve) => request.signal.addEventListener('abort', () => resolve(ok({ status: 'killed', exitCode: 137, error: 'the run stopped, so the command was ended' })))),
      },
      scratch: { volumeFor: async () => ({ taskId: 't', volume: 'v' }), afterExec: async () => ({ reset: false }), sweep: async () => 0 },
      network: { check: async () => ({ ok: true }), open: async () => Promise.reject(new Error('no')) },
      logger: silentLogger,
      clock,
      image: 'okc-sandbox:1',
      probe: () => ({ available: true, reason: null, engine: 'docker 28', imageId: 'sha256:x' }),
      live,
      running,
    });
    const ctx = { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock, signal: new AbortController().signal, toolCallId: 'c1' };
    const pending = tool.run(tool.input.parse({ language: 'bash', code: 'sleep 100' }), ctx);
    await vi.waitFor(() => expect(running.size).toBe(1));
    for (const exec of running.values()) exec.stop.abort();
    const out = await pending;
    expect(out.content).toMatch(/^Killed/);
    expect(running.size).toBe(0);
    expect(live.size).toBe(0);
  });
});
