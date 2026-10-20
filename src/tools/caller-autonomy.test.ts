import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createTestCaller } from '../../test/harness.js';
import { openDb } from '../db/index.js';
import type { AutonomyDomain, AutonomyLevel } from '../policy/autonomy.js';
import { changeLevel } from '../policy/autonomy-store.js';
import type { ReviewRequest, Reviewer } from '../policy/policy.js';
import type { ToolCallerDeps } from './caller.js';
import { createToolRegistry, defineTool } from './registry.js';

// the tool caller reads the level of the domain of each call, and the decision row keeps it for the trace.
function setup(extra: Partial<ToolCallerDeps> = {}) {
  const db = openDb(':memory:');
  const clock = () => new Date('2026-10-19T17:00:00Z');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
  const ran: string[] = [];
  const tool = (name: string) =>
    defineTool({
      name,
      description: name,
      input: z.object({ to: z.array(z.string()).default([]), body: z.string().default('') }),
      risk: 'write',
      async run() {
        ran.push(name);
        return { content: `${name} done` };
      },
    });
  const reviews: ReviewRequest[] = [];
  const reviewer: Reviewer = async (request) => {
    reviews.push(request);
    return { verdict: 'allow', reason: 'checked' };
  };
  const tools = createToolRegistry([tool('google__gmail_draft'), tool('memory_write')]);
  const { caller } = createTestCaller(db, tools, clock, { reviewer, ...extra });
  const allowed = ['google__gmail_draft', 'memory_write'];
  const call = (name: string, id: string) =>
    caller.call({ id, name, input: { to: ['ana@example.com'], body: 'Thursday works.' } }, { runId: 'r1', sessionKey: 'main', allowed, signal: new AbortController().signal });
  const row = (id: string) => db.prepare('SELECT * FROM tool_calls WHERE toolCallId = ?').get(id) as Record<string, unknown>;
  const decision = (id: string) => db.prepare('SELECT * FROM policy_decisions WHERE toolCallId = ?').get(id) as Record<string, unknown> | undefined;
  const raise = (domain: AutonomyDomain, level: AutonomyLevel) => changeLevel(db, { domain, level, actor: 'owner', via: 'dashboard' }, clock());
  return { db, call, row, decision, raise, ran, reviews };
}

describe('the tool caller with the trust ladder', () => {
  it('runs a draft with no reviewer call when the owner raised mail drafts to auto', async () => {
    const { call, decision, raise, ran, reviews } = setup();
    raise('mail_drafts', 'auto');
    expect(await call('google__gmail_draft', 'd1')).toEqual({ content: 'google__gmail_draft done' });
    expect(ran).toEqual(['google__gmail_draft']);
    expect(reviews).toEqual([]);
    expect(decision('d1')).toMatchObject({
      decision: 'allow',
      rule: 'autonomy:mail_drafts',
      reason: 'the owner set mail drafts to auto',
      autonomyDomain: 'mail_drafts',
      autonomyLevel: 'auto',
      reviewerVerdict: null,
    });
  });

  it('sends a draft to the reviewer at the default level, and records the level', async () => {
    const { call, decision, ran, reviews } = setup();
    await call('google__gmail_draft', 'd1');
    expect(reviews.map((each) => each.tool)).toEqual(['google__gmail_draft']);
    expect(ran).toEqual(['google__gmail_draft']);
    expect(decision('d1')).toMatchObject({
      decision: 'review',
      rule: 'risk:write',
      autonomyDomain: 'mail_drafts',
      autonomyLevel: 'review',
      reviewerVerdict: 'allow',
    });
  });

  it('keeps null levels for a call outside the ladder', async () => {
    const { call, decision } = setup();
    await call('memory_write', 'm1');
    expect(decision('m1')).toMatchObject({ decision: 'allow', rule: 'builtin:memory_write', autonomyDomain: null, autonomyLevel: null });
  });

  it('does not run the tool when the level cannot be read', async () => {
    const { call, row, decision, ran, reviews } = setup({
      autonomyLevel: () => {
        throw new Error('the database is locked');
      },
    });
    const output = await call('google__gmail_draft', 'd1');
    expect(output).toEqual({ content: 'google__gmail_draft did not run, because its policy check failed: the database is locked', isError: true });
    expect(ran).toEqual([]);
    expect(reviews).toEqual([]);
    expect(decision('d1')).toBeUndefined();
    expect(JSON.parse(String(row('d1').output))).toEqual(output);
  });
});
