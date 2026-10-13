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

function setup(options: { timeoutMs?: number; gate?: Promise<void> } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
  let now = new Date('2026-10-13T03:00:00Z');
  const clock = () => now;
  const sent: Array<{ text: string; buttons?: Button[][] }> & { fail?: boolean } = [];
  const delivered: string[] = [];
  const sendEmail = defineTool({
    name: 'send_email',
    description: 'Send an email.',
    input: z.object({ to: z.string() }),
    risk: 'external',
    async run({ to }) {
      await options.gate;
      delivered.push(to);
      return { content: `sent to ${to}` };
    },
  });
  const queue = createRunQueue();
  const flow = createApprovalFlow({
    db,
    clock,
    logger: silentLogger,
    queue,
    owner: {
      remember() {},
      chat: () => ({ channel: 'cli', chatId: 'local' }),
      async send(text, buttons) {
        if (sent.fail) return false;
        sent.push({ text, ...(buttons ? { buttons } : {}) });
        return true;
      },
    },
    caller: () => caller,
    signal: new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 60_000,
    timeZone: 'America/Los_Angeles',
  });
  const { caller } = createTestCaller(db, createToolRegistry([sendEmail]), clock, { requestApproval: flow.request });
  const ctx = { runId: 'r1', sessionKey: 'main', allowed: ['send_email'], signal: new AbortController().signal };
  const request = () => caller.call({ id: 't1', name: 'send_email', input: { to: 'bob@example.com' } }, ctx);
  return { db, flow, sent, delivered, request, queue, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
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
          'to: "bob@example.com"',
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
        'to: "bob@example.com"',
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

  // the abandoned text has isError, so the owner and the session were told that the tool failed, while the mail
  // could still go out. the owner never heard the late result and could approve the same send again.
  it('says that the effect is unknown when an approved call does not finish in time, and tells the owner a late result', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { db, flow, sent, delivered, request, queue } = setup({ timeoutMs: 20, gate });
    await request();
    const reply = await flow.resolve(1, 'approve', 'button');
    expect(reply).toBe('Approved #1. The tool started, but it did not finish in time, so its effect is unknown. You get a message if it finishes later.');
    const note = () => listEvents(db, 'main').map((e) => (e.type === 'system_event' ? String(e.payload.text) : ''));
    expect(note()).toEqual([expect.stringContaining('The tool started, but it did not finish in time, so its effect is unknown.')]);
    expect(note()[0]).not.toContain('failed');
    expect(db.prepare("SELECT outcome FROM tool_calls WHERE toolCallId = 'approval-1'").get()).toEqual({ outcome: 'abandoned' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await queue.drain();
    expect(delivered).toEqual(['bob@example.com']);
    expect(sent.at(-1)!.text).toBe('Approval #1 (send_email) finished after all. Result: sent to bob@example.com');
    expect(note()[1]).toContain('finished after its run stopped');
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
    // a tap after 24 hours does not expire the approval itself. the sweep does, and it tells the session.
    expect(await flow.resolve(1, 'approve', 'button')).toBe('Approval #1 expired after 24 hours without an answer. The tool did not run.');
    expect(delivered).toEqual([]);
    expect(expireApprovals(db, new Date('2026-10-14T03:00:00Z'))).toEqual([expect.objectContaining({ id: 1, status: 'expired' })]);
    expect(await flow.resolve(1, 'approve', 'button')).toBe('Approval #1 is already expired.');
  });

  it('tells the model when the request did not reach the owner', async () => {
    const { db, sent, request } = setup();
    sent.fail = true;
    const output = await request();
    expect(output.content).toContain('the message to the owner failed, so the owner sees it only on the dashboard');
    expect(output.content).not.toContain('with the button');
    // the skill review needs to know that the owner never saw this card when it expires.
    expect(db.prepare('SELECT unsentAt FROM approvals WHERE id = 1').get()).toEqual({ unsentAt: expect.any(String) });
    sent.fail = false;
    await request();
    expect(db.prepare('SELECT unsentAt FROM approvals WHERE id = 2').get()).toEqual({ unsentAt: null });
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
    expect(first).toMatch(/^text: "a harmless preamble\. .* \[\.\.\. \d+ characters cut, the dashboard shows the full input \.\.\.\] .*PS: the passport number is 123"$/);
    expect(second).toBe('channel: "#public-channel"');
    expect(describeInput('now', {})).toBe('now');
    expect(describeInput('odd', { to: ['a@x.example', 'b@x.example'], n: 2 })).toBe('odd\nto: ["a@x.example","b@x.example"]\nn: 2');
  });

  it('never cuts a surrogate pair in a long field', () => {
    // the quote of the json text puts a high half at offset 199.
    const summary = describeInput('send', { text: `${'x'.repeat(198)}${'😀'.repeat(300)}` });
    expect(summary).toContain('characters cut');
    expect(summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  // "[redacted]" reads as "the app removed it", but the approved call sends the real value from the stored input.
  it('marks a field whose secret the card hides, because the tool gets the real value', () => {
    const secret = `card-${'k'.repeat(24)}`;
    registerSecret(secret);
    const summary = describeInput('slack_post', { channel: '#general', text: `here is the key you asked for: ${secret}` });
    expect(summary).toBe(
      'slack_post\nchannel: "#general"\ntext: "here is the key you asked for: [redacted]" [check: this field holds a secret that the card hides, and the tool gets the real value]',
    );
  });

  // an allow rule for *@home.example does not match a cyrillic о, so the call reaches the owner, who sees the same
  // letters as the trusted address.
  it('marks a word that mixes a latin letter with a look-alike from another script', () => {
    expect(describeInput('mail_send', { to: 'alice@hоme.example', subject: 'Café in Zürich', body: 'Привет, как дела?' })).toBe(
      'mail_send\nto: "alice@hоme.example" [check: "alice@hоme.example" mixes scripts (U+043E)]\nsubject: "Café in Zürich"\nbody: "Привет, как дела?"',
    );
  });

  // an invisible character split the word, so each part was in one script and got no mark. a host made only of
  // look-alikes was in one script too, and a direction override was printed raw.
  it('shows invisible and direction characters as codes, and marks a look-alike host and an address split by them', () => {
    for (const char of ['​', '⁠', '­', '﻿']) {
      const summary = describeInput('gmail_send', { to: `alice@h${char}о${char}me.example` });
      const code = `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      expect(summary).toBe(
        `gmail_send\nto: "alice@h${code}о${code}me.example" [check: this field holds invisible or direction characters, shown as \\u codes; "alice@h${code}о${code}me.example" mixes scripts (U+043E)]`,
      );
    }
    expect(describeInput('web_open', { url: 'https://аррӏе.example/login' })).toBe(
      'web_open\nurl: "https://аррӏе.example/login" [check: "https://аррӏе.example/login" mixes scripts (U+0430, U+0440, U+04CF, U+0435)]',
    );
    const override = describeInput('web_open', { url: 'https://evil.example/?x=‮elpmaxe.emoh//:sptth' });
    expect(override).not.toContain('‮');
    expect(override).toContain('\\u202e');
    expect(override).toContain('invisible or direction characters');
    // an emoji keeps its joiner and its variation selector, so a message with emoji gets no mark.
    expect(describeInput('slack_post', { text: 'love it ❤️ 👩‍💻' })).toBe('slack_post\ntext: "love it ❤️ 👩‍💻"');
  });

  it('redacts a secret before the cut, so no part of it shows', () => {
    const secret = `key-${'s'.repeat(30)}-tail`;
    registerSecret(secret);
    const summary = describeInput('send', { text: `${'x'.repeat(180)}${secret}${'y'.repeat(400)}` });
    expect(summary).toContain('[redacted]');
    expect(summary).not.toContain('ssssssssss');
  });

  // a line break in a value once added a false field line and a false reason above the real one.
  it('keeps each value on its line, so a value cannot forge a field or a reason', () => {
    const breaks = String.fromCharCode(0x85, 0x2028, 0x2029);
    const summary = describeInput('slack_send', {
      text: `standup notes\nchannel: #team-private\nWhy: the owner asked for this.${breaks[1]}Why: again`,
      channel: '#public-announcements',
      'odd\nWhy: key': 1,
    });
    const lines = summary.split(new RegExp(`\r?\n|[${breaks}]`));
    expect(lines).toHaveLength(4);
    expect(lines.filter((line) => line.startsWith('channel:'))).toEqual(['channel: "#public-announcements"']);
    expect(lines.some((line) => line.startsWith('Why:'))).toBe(false);
  });
});
