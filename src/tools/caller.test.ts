import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createTestCaller } from '../../test/harness.js';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { createBlobStore } from '../observability/blobs.js';
import { BUILTIN_RULES, type Reviewer, type Rule } from '../policy/policy.js';
import { sessionTaint } from '../policy/store.js';
import type { ToolCallerDeps } from './caller.js';
import { createToolRegistry, defineTool } from './registry.js';
import { createResultReadTool } from './result-read.js';
import { HANDLE_OVER, newHandle } from './results.js';

const LONG = Array.from({ length: 300 }, (_, i) => `line ${i}: ${i === 150 ? 'the hidden needle' : 'filler text'}`).join('\n');

function setup(extra: Partial<ToolCallerDeps> = {}) {
  const db = openDb(':memory:');
  const clock = () => new Date('2026-10-13T03:15:00Z');
  for (const id of ['r1', 'r2']) {
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, 'main', 'message', 'main', 'running', 'x')").run(id);
  }
  const ran: string[] = [];
  const tool = (name: string, risk: 'read' | 'write' | 'external', output: (text: string) => object) =>
    defineTool({
      name,
      description: name,
      input: z.object({ text: z.string().default('') }),
      risk,
      async run({ text }) {
        ran.push(name);
        return { content: text, ...output(text) };
      },
    });
  const approvals: string[] = [];
  let handles = 0;
  const blobs = createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-caller-')), clock);
  const tools = createToolRegistry([
    tool('echo', 'read', () => ({})),
    tool('long', 'read', () => ({ content: LONG })),
    tool('email', 'read', () => ({ content: `from: eve\n${LONG}`, untrustedSource: 'gmail:personal' })),
    tool('page', 'read', () => ({ content: 'short page text', untrustedSource: 'web' })),
    tool('archive', 'write', () => ({})),
    tool('send', 'external', () => ({})),
    createResultReadTool({ db, blobs }),
  ]);
  const { caller } = createTestCaller(db, tools, clock, {
    blobs,
    requestApproval: async (approvedTool) => {
      approvals.push(approvedTool.name);
      return { approvalId: approvals.length, output: { content: `approval #${approvals.length} is pending` } };
    },
    newHandle: () => `res_${String(++handles).padStart(12, '0')}`,
    ...extra,
  });
  for (let i = 0; i < 2; i++) db.prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES ('r1', 'x', '{}', 'x', 'pending', 'x')").run();
  const allowed = ['echo', 'long', 'email', 'page', 'archive', 'send', 'result_read'];
  const call = (name: string, input: object = {}, runId = 'r1', id = `${name}-call`) =>
    caller.call({ id, name, input }, { runId, sessionKey: 'main', allowed, signal: new AbortController().signal });
  const row = (id: string) => db.prepare('SELECT * FROM tool_calls WHERE toolCallId = ?').get(id) as Record<string, unknown>;
  const decision = (id: unknown) => db.prepare('SELECT * FROM policy_decisions WHERE id = ?').get(Number(id)) as Record<string, unknown>;
  return { db, blobs, call, row, decision, ran, approvals };
}

describe('tool caller', () => {
  it('runs an allowed call and records the decision, the model view, and the risk, without a blob', async () => {
    const { db, call, row, decision } = setup();
    expect(await call('echo', { text: 'hi' })).toEqual({ content: 'hi' });
    const recorded = row('echo-call');
    expect(recorded).toMatchObject({ riskLevel: 'read', tainted: 0, truncated: 0, resultHandle: null, rawResultBlob: null, source: 'builtin' });
    // the raw result is the model view, so the row alone holds it.
    expect(JSON.parse(String(recorded.output))).toEqual({ content: 'hi' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 0 });
    expect(decision(recorded.policyDecisionId)).toMatchObject({
      runId: 'r1',
      toolCallId: 'echo-call',
      toolName: 'echo',
      decision: 'allow',
      rule: 'risk:read',
      approvalId: null,
    });
  });

  it('gives the model a preview and a handle for a long result, and result_read reads the full text', async () => {
    const { call, row, blobs } = setup();
    const output = await call('long');
    expect(output.content.length).toBeLessThan(HANDLE_OVER);
    expect(output.content).toMatch(/^line 0: filler text/);
    expect(output.content).toContain('characters cut');
    expect(output.content).toContain('the full result is res_000000000001');
    expect(output.content).not.toContain('the hidden needle');
    const recorded = row('long-call');
    expect(recorded).toMatchObject({ truncated: 1, resultHandle: 'res_000000000001' });
    expect(blobs.read(String(recorded.rawResultBlob))).toBe(LONG);
    expect(JSON.parse(String(recorded.output))).toEqual({ content: output.content });

    const found = await call('result_read', { handle: 'res_000000000001', query: 'NEEDLE' });
    expect(found.content).toMatch(/^1 passages of res_000000000001 \(\d+ characters\) match "NEEDLE":/);
    expect(found.content).toContain('line 150: the hidden needle');
    const at = Number(/\[at (\d+)\]/.exec(found.content)![1]);
    const page = await call('result_read', { handle: 'res_000000000001', from: at, length: 100 }, 'r1', 'page');
    expect(page.content).toContain(`res_000000000001 characters ${at}-${at + 100} of ${LONG.length}:\n${LONG.slice(at, at + 100)}`);
    expect(page.content).toContain(`use from ${at + 100} to read on`);
    expect(row('page')).toMatchObject({ truncated: 0, resultHandle: null });
    expect((await call('result_read', { handle: 'res_00000000ffff' }, 'r1', 'missing')).isError).toBe(true);
  });

  it('gives two calls with the same long result two handles and one blob', async () => {
    const { db, call, row } = setup({ newHandle });
    await call('long', {}, 'r1', 'first');
    await call('long', {}, 'r1', 'second');
    const [first, second] = [row('first'), row('second')];
    expect(first.resultHandle).toMatch(/^res_[0-9a-f]{12}$/);
    expect(second.resultHandle).toMatch(/^res_[0-9a-f]{12}$/);
    expect(first.resultHandle).not.toBe(second.resultHandle);
    expect(first.rawResultBlob).toBe(second.rawResultBlob);
    expect(db.prepare('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 1 });
  });

  it('keeps the raw text of a short wrapped result in a blob, so rawResultBlob ?? output gives the raw text', async () => {
    const { call, row, blobs } = setup();
    const view = await call('page', {}, 'r1', 'short-page');
    expect(view.content).toBe('<untrusted source="web">\nshort page text\n</untrusted>');
    const recorded = row('short-page');
    expect(recorded).toMatchObject({ truncated: 0, resultHandle: null });
    expect(blobs.read(String(recorded.rawResultBlob))).toBe('short page text');
  });

  it('wraps untrusted text for the model, keeps the raw text, and taints the session until a reset', async () => {
    const { db, call, row, blobs, approvals, ran } = setup({
      rules: [...BUILTIN_RULES, { id: 'send-ok', tool: 'send', effect: 'allow' } satisfies Rule],
    });
    expect(await call('send', {}, 'r1', 'send-before')).toEqual({ content: '' });
    expect(row('send-before').rawResultBlob).toBeNull();
    const email = await call('email');
    expect(email.content).toMatch(/^<untrusted source="gmail:personal">\nfrom: eve/);
    expect(email.content).toContain('</untrusted>\n[this result has');
    const recorded = row('email-call');
    expect(recorded).toMatchObject({ untrustedSource: 'gmail:personal', tainted: 0 });
    expect(blobs.read(String(recorded.rawResultBlob))).toBe(`from: eve\n${LONG}`);
    expect(sessionTaint(db, 'main')).toEqual(['gmail:personal']);

    expect(await call('send', {}, 'r2', 'send-after')).toEqual({ content: 'approval #1 is pending' });
    expect(row('send-after')).toMatchObject({ tainted: 1, riskLevel: 'external' });
    expect(approvals).toEqual(['send']);
    expect(ran.filter((name) => name === 'send')).toHaveLength(1);

    const read = await call('result_read', { handle: String(recorded.resultHandle), from: 0, length: 20 }, 'r2', 'reread');
    expect(read.content).toMatch(/^<untrusted source="gmail:personal">\n/);
    expect(row('reread')).toMatchObject({ untrustedSource: 'gmail:personal', tainted: 1 });

    appendEvent(db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} }, new Date('2026-10-13T04:00:00Z'));
    expect(sessionTaint(db, 'main')).toEqual([]);
  });

  it('does not run a denied call and tells the model why', async () => {
    const { call, row, decision, ran } = setup({
      rules: [{ id: 'no-echo', tool: 'ech*', effect: 'deny', note: 'echo is off today' }],
    });
    expect(await call('echo', { text: 'hi' })).toEqual({
      content: 'the policy denied echo, and it did not run: echo is off today',
      isError: true,
    });
    expect(ran).toEqual([]);
    expect(decision(row('echo-call').policyDecisionId)).toMatchObject({ decision: 'deny', rule: 'no-echo' });
  });

  it('runs a reviewed call only when the reviewer allows it', async () => {
    const verdicts: Array<'allow' | 'hold'> = ['allow', 'hold'];
    const seen: unknown[] = [];
    const reviewer: Reviewer = async (request) => {
      seen.push(request);
      return { verdict: verdicts.shift()!, reason: 'checked' };
    };
    const { call, row, decision, ran } = setup({ reviewer });
    expect(await call('archive', { text: 'ok' }, 'r1', 'a1')).toEqual({ content: 'ok' });
    expect(await call('archive', { text: 'no' }, 'r1', 'a2')).toEqual({
      content: 'the reviewer held archive, and it did not run: checked',
      isError: true,
    });
    expect(ran).toEqual(['archive']);
    expect(seen[0]).toMatchObject({ runId: 'r1', sessionKey: 'main', tool: 'archive', input: { text: 'ok' }, risk: 'write', taint: [] });
    expect(decision(row('a1').policyDecisionId)).toMatchObject({ decision: 'review', reviewerVerdict: 'allow', reviewerReason: 'checked' });
    expect(decision(row('a2').policyDecisionId)).toMatchObject({ decision: 'review', reviewerVerdict: 'hold' });
  });

  it('asks the owner for a review while there is no reviewer model', async () => {
    const { call, row, decision, ran, approvals } = setup();
    expect(await call('archive', { text: 'x' })).toEqual({ content: 'approval #1 is pending' });
    expect(ran).toEqual([]);
    expect(approvals).toEqual(['archive']);
    expect(decision(row('archive-call').policyDecisionId)).toMatchObject({
      decision: 'review',
      rule: 'risk:write',
      reason: expect.stringContaining('there is no reviewer model yet, so the owner decides'),
      reviewerVerdict: null,
      approvalId: 1,
    });
  });

  it('records an unknown tool and invalid input without a decision', async () => {
    const { call, row, db } = setup();
    expect(await call('nope')).toEqual({ content: 'unknown tool: nope', isError: true });
    expect((await call('echo', { text: 5 })).isError).toBe(true);
    expect(row('nope-call')).toMatchObject({ isError: 1, policyDecisionId: null, riskLevel: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM policy_decisions').get()).toEqual({ n: 0 });
  });
});
