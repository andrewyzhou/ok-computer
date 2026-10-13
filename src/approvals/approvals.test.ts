import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { Button } from '../channels/types.js';
import { openDb } from '../db/index.js';
import { listEvents } from '../events/log.js';
import { silentLogger } from '../observability/logger.js';
import { createRunQueue } from '../sessions/queue.js';
import { createToolRegistry, defineTool } from '../tools/registry.js';
import { createApprovalFlow } from './flow.js';
import { expireApprovals, getApproval, parseApprovalButton } from './store.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
  let now = new Date('2026-10-13T03:00:00Z');
  const clock = () => now;
  const sent: Array<{ text: string; buttons?: Button[][] }> = [];
  const delivered: string[] = [];
  const sendEmail = defineTool({
    name: 'send_email',
    description: 'Send an email.',
    input: z.object({ to: z.string() }),
    risk: 'external',
    async run({ to }) {
      delivered.push(to);
      return { content: `sent to ${to}` };
    },
  });
  const flow = createApprovalFlow({
    db,
    clock,
    logger: silentLogger,
    queue: createRunQueue(),
    owner: {
      remember() {},
      chat: () => ({ channel: 'cli', chatId: 'local' }),
      async send(text, buttons) {
        sent.push({ text, ...(buttons ? { buttons } : {}) });
        return true;
      },
    },
    timeZone: 'America/Los_Angeles',
    tools: () => registry,
    signal: new AbortController().signal,
  });
  const registry = createToolRegistry([sendEmail], { gate: flow.gate });
  const ctx = { runId: 'r1', sessionKey: 'main', timeZone: 'UTC', clock, signal: new AbortController().signal };
  const request = () => registry.run({ id: 't1', name: 'send_email', input: { to: 'bob@example.com' } }, ['send_email'], ctx);
  return { db, flow, sent, delivered, request, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('approvals', () => {
  it('pauses an external tool and asks the owner with approve and deny buttons', async () => {
    const { db, sent, delivered, request } = setup();
    const output = await request();
    expect(output.content).toContain('Approval #1 is pending');
    expect(delivered).toEqual([]);
    expect(sent).toEqual([
      {
        text: 'Approval needed (#1): send_email {"to":"bob@example.com"}',
        buttons: [[{ text: 'Approve', data: 'approval:1:approve' }, { text: 'Deny', data: 'approval:1:deny' }]],
      },
    ]);
    expect(getApproval(db, 1)).toMatchObject({ status: 'pending', sessionKey: 'main', toolName: 'send_email' });
  });

  it('runs the tool after approval and gives the result to the session', async () => {
    const { db, flow, delivered, request } = setup();
    await request();
    expect(await flow.resolve(1, 'approve', 'button')).toBe('Approved #1. Result: sent to bob@example.com');
    expect(delivered).toEqual(['bob@example.com']);
    expect(getApproval(db, 1)).toMatchObject({ status: 'approved', resolvedBy: 'button' });
    expect(listEvents(db, 'main').map((e) => e.type === 'system_event' && e.payload.text)).toEqual([
      expect.stringContaining('The owner approved #1'),
    ]);
    expect(db.prepare('SELECT name, isError FROM tool_calls').all()).toEqual([{ name: 'send_email', isError: 0 }]);
    expect(await flow.resolve(1, 'approve', 'command')).toBe('Approval #1 is already approved.');
    expect(delivered).toHaveLength(1);
  });

  it('does not run the tool after a denial', async () => {
    const { db, flow, delivered, request } = setup();
    await request();
    expect(await flow.resolve(1, 'deny', 'command')).toBe('Denied #1.');
    expect(delivered).toEqual([]);
    expect(listEvents(db, 'main')[0]).toMatchObject({ type: 'system_event', payload: { text: expect.stringContaining('denied') } });
  });

  it('expires a pending approval after 24 hours', async () => {
    const { db, flow, delivered, request, advance } = setup();
    await request();
    advance(23 * 60 * 60_000);
    expect(expireApprovals(db, new Date('2026-10-14T02:00:00Z'))).toBe(0);
    advance(60 * 60_000);
    expect(await flow.resolve(1, 'approve', 'button')).toBe('Approval #1 is already expired.');
    expect(delivered).toEqual([]);
  });

  it('parses only well-formed button data', () => {
    expect(parseApprovalButton('approval:12:deny')).toEqual({ id: 12, decision: 'deny' });
    expect(parseApprovalButton('approval:12:yes')).toBeUndefined();
  });
});
