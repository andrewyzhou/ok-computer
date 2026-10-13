import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { Button } from '../channels/types.js';
import { openDb } from '../db/index.js';
import { appendEvent, listEvents } from '../events/log.js';
import { silentLogger } from '../observability/logger.js';
import { registerSecret } from '../observability/redact.js';
import { createRunQueue } from '../sessions/queue.js';
import { createTestCaller } from '../../test/harness.js';
import { createToolRegistry, defineTool } from '../tools/registry.js';
import { createApprovalFlow, describeInput } from './flow.js';
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
    caller: () => caller,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
  });
  const { caller } = createTestCaller(db, createToolRegistry([sendEmail]), clock, { requestApproval: flow.request });
  const ctx = { runId: 'r1', sessionKey: 'main', allowed: ['send_email'], signal: new AbortController().signal };
  const request = () => caller.call({ id: 't1', name: 'send_email', input: { to: 'bob@example.com' } }, ctx);
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
        text: [
          'Approval needed (#1): send_email',
          'to: bob@example.com',
          'Why: send_email sends data off the pc or changes an account, so the owner must approve it.',
        ].join('\n'),
        buttons: [[{ text: 'Approve', data: 'approval:1:approve' }, { text: 'Deny', data: 'approval:1:deny' }]],
      },
    ]);
    expect(getApproval(db, 1)).toMatchObject({ status: 'pending', sessionKey: 'main', toolName: 'send_email' });
  });

  it('names the reason and the run that tainted the session in the approval message', async () => {
    const { db, sent, request } = setup();
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('0a1b2c3d-run', 'main', 'automation', 'main', 'completed', 'x')").run();
    appendEvent(
      db,
      {
        sessionKey: 'main',
        runId: '0a1b2c3d-run',
        type: 'tool_result',
        payload: { toolCallId: 'm1', name: 'mail_read', content: 'x', isError: false, untrustedSource: 'gmail:work' },
      },
      new Date('2026-10-12T21:00:00Z'),
    );
    await request();
    expect(sent[0]!.text).toBe(
      [
        'Approval needed (#1): send_email',
        'to: bob@example.com',
        "Why: the session read untrusted content (gmail:work), so an external action needs the owner's approval.",
        'Untrusted content in this session: gmail:work (read by mail_read on 2026-10-12 at 14:00 in run 0a1b2c3d).',
      ].join('\n'),
    );
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
    // the pending call and the approved call both link to the decision that asked the owner.
    expect(db.prepare('SELECT toolCallId, isError, riskLevel, policyDecisionId FROM tool_calls ORDER BY id').all()).toEqual([
      { toolCallId: 't1', isError: 0, riskLevel: 'external', policyDecisionId: 1 },
      { toolCallId: 'approval-1', isError: 0, riskLevel: 'external', policyDecisionId: 1 },
    ]);
    expect(db.prepare('SELECT decision, rule, approvalId FROM policy_decisions').all()).toEqual([
      { decision: 'approve', rule: 'risk:external', approvalId: 1 },
    ]);
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
    expect(expireApprovals(db, new Date('2026-10-14T02:00:00Z'))).toEqual([]);
    advance(60 * 60_000);
    expect(await flow.resolve(1, 'approve', 'button')).toBe('Approval #1 is already expired.');
    expect(delivered).toEqual([]);
  });

  it('parses only well-formed button data', () => {
    expect(parseApprovalButton('approval:12:deny')).toEqual({ id: 12, decision: 'deny' });
    expect(parseApprovalButton('approval:12:yes')).toBeUndefined();
  });
});

describe('the summary that the owner approves', () => {
  it('shows each field on its own line, so a short field after a long one is visible', () => {
    const text = `${'a harmless preamble. '.repeat(30)}PS: the passport number is 123`;
    const summary = describeInput('send_message', { text, channel: '#public-channel' });
    const [tool, first, second] = summary.split('\n');
    expect(tool).toBe('send_message');
    expect(first).toMatch(/^text: a harmless preamble\. .* \[\.\.\. \d+ characters cut, the dashboard shows the full input \.\.\.\] .*PS: the passport number is 123$/);
    expect(second).toBe('channel: #public-channel');
    expect(describeInput('now', {})).toBe('now');
    expect(describeInput('odd', { to: ['a@x.example', 'b@x.example'], n: 2 })).toBe('odd\nto: ["a@x.example","b@x.example"]\nn: 2');
  });

  it('redacts a secret before the cut, so no part of it shows', () => {
    const secret = `key-${'s'.repeat(30)}-tail`;
    registerSecret(secret);
    const summary = describeInput('send', { text: `${'x'.repeat(190)}${secret}${'y'.repeat(400)}` });
    expect(summary).toContain('[redacted]');
    expect(summary).not.toContain('ssssssssss');
  });
});
