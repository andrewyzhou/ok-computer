import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createTestCaller } from '../../test/harness.js';
import { closeStaleWork, repairSession } from '../agent/recovery.js';
import { openDb } from '../db/index.js';
import { appendEvent, listEvents } from '../events/log.js';
import { silentLogger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import { createRunQueue } from '../sessions/queue.js';
import type { ToolCaller } from '../tools/caller.js';
import { createToolRegistry, defineTool } from '../tools/registry.js';
import { createApprovalFlow } from './flow.js';
import { getApproval } from './store.js';

const T0 = new Date('2026-10-13T03:15:00Z');
// the app uses the longest run timeout plus 5 minutes.
const STALE_MS = 35 * 60_000;
const LATER = new Date(T0.getTime() + STALE_MS + 60_000);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// the world has one external tool, a session queue, and the real approval flow. run controls how the tool ends.
function world(run: () => Promise<{ content: string }>, options: { timeoutMs?: number; send?: OwnerMessenger['send'] } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', ?)").run(
    T0.toISOString(),
  );
  const ran: string[] = [];
  const send = defineTool({
    name: 'send',
    description: 'Sends.',
    input: z.object({}),
    risk: 'external',
    async run() {
      ran.push('send');
      return run();
    },
  });
  const queue = createRunQueue();
  const shutdown = new AbortController();
  const owner: string[] = [];
  let caller!: ToolCaller;
  const flow = createApprovalFlow({
    db,
    clock: () => T0,
    logger: silentLogger,
    queue,
    owner: { remember() {}, chat: () => undefined, send: options.send ?? (async (text) => (owner.push(text), true)) },
    caller: () => caller,
    signal: shutdown.signal,
    timeoutMs: options.timeoutMs ?? 60_000,
    timeZone: 'America/Los_Angeles',
  });
  caller = createTestCaller(db, createToolRegistry([send]), () => T0, { requestApproval: flow.request, queue }).caller;
  const ask = () => caller.call({ id: 'c1', name: 'send', input: {} }, { runId: 'r1', sessionKey: 'main', allowed: ['send'], signal: new AbortController().signal });
  const notes = () => listEvents(db, 'main').flatMap((event) => (event.type === 'system_event' ? [event.payload.text] : []));
  const rows = () => db.prepare("SELECT outcome, isError FROM tool_calls WHERE toolCallId = 'approval-1' ORDER BY id").all();
  // the main session is busy with a long run, so the approved call waits in the queue.
  const hold = () => {
    let release!: () => void;
    void queue.enqueue('main', () => new Promise<void>((resolve) => (release = resolve)));
    return () => release();
  };
  return { db, queue, shutdown, flow, ask, ran, owner, notes, rows, hold };
}

describe('the life of an approved call', () => {
  it('is not expired by the sweep of its own process while it waits in the session queue', async () => {
    const w = world(async () => ({ content: 'sent' }));
    await w.ask();
    const release = w.hold();
    const reply = w.flow.resolve(1, 'approve', 'button');
    await tick();
    expect(w.flow.active.has(1)).toBe(true);
    const stale = closeStaleWork(w.db, LATER, STALE_MS, { runs: [], approvals: w.flow.active });
    expect(stale).toEqual({ runs: [], expired: [], interrupted: [] });
    release();
    expect(await reply).toBe('Approved #1. Result: sent');
    expect(w.ran).toEqual(['send']);
    expect(w.flow.active.size).toBe(0);
    expect(w.notes()).toEqual(['The owner approved #1 (send). The tool ran. Result:\nsent']);
  });

  it('says that an expired call did not run, not that it already ran', async () => {
    const w = world(async () => ({ content: 'sent' }));
    await w.ask();
    const release = w.hold();
    const reply = w.flow.resolve(1, 'approve', 'button');
    await tick();
    // a second process, for example npm run chat, does not know the live approvals of this process.
    expect(closeStaleWork(w.db, LATER, STALE_MS).expired.map((each) => each.id)).toEqual([1]);
    release();
    expect(await reply).toBe('Approved #1. The tool did not run: approval #1 expired before it could run, so it did not run');
    expect(w.ran).toEqual([]);
    expect(w.notes()[0]).toMatch(/^The owner approved #1 \(send\)\. The tool did not run\. Result:/);
  });

  it('leaves the approval unclaimed when the app stops while the call waits, so the next sweep reports it', async () => {
    const w = world(async () => ({ content: 'sent' }));
    await w.ask();
    const release = w.hold();
    const reply = w.flow.resolve(1, 'approve', 'button');
    await tick();
    w.shutdown.abort();
    release();
    await reply;
    expect(w.ran).toEqual([]);
    expect(w.db.prepare('SELECT status, startedAt FROM approvals WHERE id = 1').get()).toEqual({ status: 'approved', startedAt: null });
    expect(w.rows()).toEqual([]);
    expect(w.notes()[0]).toMatch(/The tool did not run\. Result:\napproval #1 did not run, because the app stopped first$/);
    expect(closeStaleWork(w.db, LATER, STALE_MS).expired.map((each) => each.id)).toEqual([1]);
  });

  it('abandons an approved tool that never returns, so the session queue goes on', async () => {
    let finish!: () => void;
    const w = world(() => new Promise((resolve) => (finish = () => resolve({ content: 'sent late' }))), { timeoutMs: 50 });
    await w.ask();
    const reply = await w.flow.resolve(1, 'approve', 'button');
    expect(reply).toMatch(/^Approved #1\. The tool failed: send did not finish before the run stopped/);
    let later = false;
    await w.queue.enqueue('main', async () => void (later = true));
    expect(later).toBe(true);
    // the row exists, so the sweep does not call the live call interrupted.
    expect(closeStaleWork(w.db, LATER, STALE_MS).interrupted).toEqual([]);
    finish();
    await tick();
    await w.queue.drain();
    expect(w.rows()).toEqual([{ outcome: 'late', isError: 0 }]);
    expect(w.notes().at(-1)).toMatch(/^send \(call approval-1\) finished after its run stopped\. Result:\nsent late$/);
  });

  it('is not called interrupted by the sweep of its own process while the tool still runs', async () => {
    let finish!: () => void;
    const w = world(() => new Promise((resolve) => (finish = () => resolve({ content: 'sent' }))));
    await w.ask();
    const reply = w.flow.resolve(1, 'approve', 'button');
    await tick();
    expect(closeStaleWork(w.db, LATER, STALE_MS, { runs: [], approvals: w.flow.active }).interrupted).toEqual([]);
    finish();
    await reply;
    expect(w.rows()).toEqual([{ outcome: null, isError: 0 }]);
  });

  it('links the decision to the approval before the message to the owner, so a crash during the message keeps the call waiting', async () => {
    const w = world(async () => ({ content: 'sent' }), { send: () => new Promise<boolean>(() => {}) });
    appendEvent(
      w.db,
      {
        sessionKey: 'main',
        runId: 'r1',
        type: 'assistant_message',
        payload: { provider: 'fake', model: 'm', content: [], text: '', toolCalls: [{ id: 'c1', name: 'send', input: {} }], stopReason: 'tool_use' },
      },
      T0,
    );
    void w.ask();
    await tick();
    // the process stops here. the next process repairs the session.
    repairSession(w.db, 'main', () => T0);
    expect(w.db.prepare('SELECT approvalId FROM policy_decisions').get()).toEqual({ approvalId: 1 });
    expect(getApproval(w.db, 1)?.status).toBe('pending');
    const repaired = listEvents(w.db, 'main').find((event) => event.type === 'tool_result');
    expect(repaired?.payload).toMatchObject({ content: expect.stringContaining("waits for the owner's approval #1"), isError: false });
  });
});

describe('the stale sweep', () => {
  it('does not close a run of this process after the clock moves forward', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('live', 'main', 'message', 'main', 'running', ?)").run(
      T0.toISOString(),
    );
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('dead', 'main', 'message', 'main', 'running', ?)").run(
      T0.toISOString(),
    );
    const stale = closeStaleWork(db, new Date(T0.getTime() + 60 * 60_000), STALE_MS, { runs: new Set(['live']), approvals: [] });
    expect(stale.runs).toEqual([{ id: 'dead', sessionKey: 'main' }]);
    expect(db.prepare("SELECT status FROM runs WHERE id = 'live'").get()).toEqual({ status: 'running' });
  });
});
