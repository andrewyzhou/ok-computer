import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createTestCaller } from '../../test/harness.js';
import { getApproval } from '../approvals/store.js';
import { openDb } from '../db/index.js';
import { BUILTIN_RULES, type Rule } from '../policy/policy.js';
import { updateDecision } from '../policy/store.js';
import { createToolRegistry, defineTool } from './registry.js';

// a tool whose risk depends on its input: an event with guests sends invitations to other people.
function setup(rules: Rule[] = []) {
  const db = openDb(':memory:');
  const clock = () => new Date('2026-10-13T16:00:00Z');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
  const counts = { riskFor: 0, ran: 0 };
  const event = defineTool({
    name: 'google__calendar_create_event',
    description: 'create an event',
    input: z.object({ account: z.string(), attendees: z.array(z.string()).optional() }),
    risk: 'write',
    riskFor: (input) => (counts.riskFor++, input.attendees?.length ? 'external' : 'write'),
    accountOf: (input) => input.account,
    async run() {
      counts.ran++;
      return { content: 'created' };
    },
  });
  const { caller } = createTestCaller(db, createToolRegistry([event]), clock, {
    rules: [...BUILTIN_RULES, ...rules],
    requestApproval: async (_tool, input, _ctx, why) => {
      const row = db
        .prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES ('r1', 'google__calendar_create_event', ?, 'x', 'pending', 'x') RETURNING id")
        .get(JSON.stringify(input))!;
      updateDecision(db, why.decisionId, { approvalId: Number(row.id) });
      return { content: `approval #${row.id} is pending` };
    },
  });
  const call = (input: object, id: string) =>
    caller.call({ id, name: 'google__calendar_create_event', input }, { runId: 'r1', sessionKey: 'main', allowed: ['google__calendar_create_event'], signal: new AbortController().signal });
  const row = (id: string) => db.prepare('SELECT riskLevel, account FROM tool_calls WHERE toolCallId = ?').get(id);
  const decision = (id: string) => db.prepare('SELECT decision, rule FROM policy_decisions WHERE toolCallId = ?').get(id);
  return { db, caller, call, row, decision, counts };
}

// the owner allows private events. an allow rule on the tool must never let it send invitations.
const allowEvents: Rule[] = [{ id: 'okc.policy.json#1', tool: 'google__calendar_create_event', effect: 'allow' }];

describe('a risk that depends on the input', () => {
  it('asks the owner for an invitation, also when a rule allows the tool', async () => {
    const t = setup(allowEvents);
    expect(await t.call({ account: 'school', attendees: ['ana@example.com'] }, 'c1')).toEqual({ content: 'approval #1 is pending' });
    expect(t.counts.ran).toBe(0);
    expect(t.decision('c1')).toEqual({ decision: 'approve', rule: 'tool' });
    expect(t.row('c1')).toEqual({ riskLevel: 'external', account: 'school' });
  });

  it('lets the rule allow a private event, which is a write', async () => {
    const t = setup(allowEvents);
    expect(await t.call({ account: 'personal' }, 'c1')).toEqual({ content: 'created' });
    expect(t.decision('c1')).toEqual({ decision: 'allow', rule: 'okc.policy.json#1' });
    expect(t.row('c1')).toEqual({ riskLevel: 'write', account: 'personal' });
  });

  // a throw or a changed answer of riskFor after the approval would run a call that the owner did not see.
  it('computes the risk one time, and the approved call keeps the risk and the account of the call that asked', async () => {
    const t = setup();
    await t.call({ account: 'school', attendees: ['ana@example.com'] }, 'c1');
    expect(t.counts.riskFor).toBe(1);
    t.db.prepare("UPDATE approvals SET status = 'approved', resolvedAt = 'y' WHERE id = 1").run();
    const result = await t.caller.callApproved(getApproval(t.db, 1)!, new AbortController().signal);
    expect(result).toMatchObject({ started: true, output: { content: 'created' } });
    expect(t.counts.riskFor).toBe(1);
    expect(t.row('approval-1')).toEqual({ riskLevel: 'external', account: 'school' });
  });
});
