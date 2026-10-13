import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES, decide, loadPolicy, type PolicyInput, type Rule } from './policy.js';

const call = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  tool: 'google__gmail_archive',
  risk: 'write',
  alwaysApprove: false,
  input: { from: 'News@Letters.example.com', ids: ['a', 'b'] },
  sessionKey: 'main',
  taint: [],
  ...overrides,
});

const rule = (id: string, fields: Omit<Rule, 'id'>): Rule => ({ id, ...fields });

describe('policy decisions', () => {
  it('decides by risk when no rule matches', () => {
    expect(decide(call({ risk: 'read' }), [])).toMatchObject({ decision: 'allow', rule: 'risk:read' });
    expect(decide(call({ risk: 'write' }), [])).toMatchObject({ decision: 'review', rule: 'risk:write' });
    expect(decide(call({ risk: 'external' }), [])).toMatchObject({ decision: 'approve', rule: 'risk:external' });
  });

  it('uses the last matching rule, with patterns on the tool, the session and the arguments', () => {
    const rules = [
      rule('a', { tool: 'google__*', effect: 'deny' }),
      rule('b', { tool: 'google__gmail_archive', args: { from: '*@letters.example.com' }, effect: 'allow', note: 'newsletters' }),
      rule('c', { tool: '*', session: 'heartbeat:*', effect: 'deny' }),
    ];
    expect(decide(call(), rules)).toEqual({ decision: 'allow', rule: 'b', reason: 'newsletters' });
    expect(decide(call({ input: { from: 'boss@work.example.com' } }), rules)).toMatchObject({ decision: 'deny', rule: 'a' });
    expect(decide(call({ input: {} }), rules)).toMatchObject({ decision: 'deny', rule: 'a' });
    expect(decide(call({ sessionKey: 'heartbeat:run-1' }), rules)).toMatchObject({ decision: 'deny', rule: 'c' });
    expect(decide(call({ tool: 'now', risk: 'read' }), rules)).toMatchObject({ decision: 'allow', rule: 'risk:read' });
  });

  it('matches an object argument against its json text', () => {
    const rules = [rule('ids', { tool: '*', args: { ids: '*"b"*' }, effect: 'deny' })];
    expect(decide(call(), rules)).toMatchObject({ decision: 'deny', rule: 'ids' });
  });

  it('sends every external call of a tainted session to the owner, also when a rule allows the tool', () => {
    const rules = [rule('send', { tool: 'gmail_send', effect: 'allow' })];
    const tainted = call({ tool: 'gmail_send', risk: 'external', taint: ['gmail:personal'] });
    expect(decide(call({ tool: 'gmail_send', risk: 'external' }), rules)).toMatchObject({ decision: 'allow', rule: 'send' });
    expect(decide(tainted, rules)).toMatchObject({
      decision: 'approve',
      rule: 'taint',
      reason: expect.stringContaining('gmail:personal'),
    });
    expect(decide(tainted, [...rules, rule('no', { tool: 'gmail_send', effect: 'deny' })])).toMatchObject({ decision: 'deny' });
    expect(decide(call({ taint: ['web'] }), [])).toMatchObject({ decision: 'review' });
    expect(decide(call({ risk: 'read', taint: ['web'] }), [])).toMatchObject({ decision: 'allow' });
  });

  it('asks the owner for a tool that always needs approval, unless a rule denies it', () => {
    const allow = [rule('x', { tool: '*', effect: 'allow' })];
    expect(decide(call({ risk: 'read', alwaysApprove: true }), allow)).toMatchObject({ decision: 'approve', rule: 'tool' });
    expect(decide(call({ alwaysApprove: true }), [rule('d', { tool: '*', effect: 'deny' })])).toMatchObject({ decision: 'deny' });
  });

  it('allows the local write tools of phase 1 with the built-in rules', () => {
    expect(decide(call({ tool: 'goals_set' }), BUILTIN_RULES)).toMatchObject({ decision: 'allow', rule: 'builtin:goals_set' });
    expect(decide(call({ tool: 'goals_set', taint: ['web'] }), BUILTIN_RULES)).toMatchObject({ decision: 'allow' });
    expect(decide(call({ tool: 'unknown_writer' }), BUILTIN_RULES)).toMatchObject({ decision: 'review' });
  });
});

describe('the policy file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'okc-policy-'));

  it('gives the built-in rules when the file is missing', () => {
    expect(loadPolicy(join(dir, 'missing.json'))).toEqual({ ok: true, value: BUILTIN_RULES });
  });

  it('puts the file rules after the built-in rules, with ids from the file', () => {
    const path = join(dir, 'okc.policy.json');
    writeFileSync(path, JSON.stringify({ rules: [{ tool: 'goals_set', effect: 'deny', note: 'no goals today' }] }));
    const loaded = loadPolicy(path);
    expect(loaded.ok && loaded.value.at(-1)).toEqual({ id: `${path}#1`, tool: 'goals_set', effect: 'deny', note: 'no goals today' });
    expect(loaded.ok && decide(call({ tool: 'goals_set' }), loaded.value)).toMatchObject({ decision: 'deny' });
  });

  it('refuses a file with an unknown effect or field', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ rules: [{ tool: 'x', effect: 'maybe' }] }));
    expect(loadPolicy(path)).toMatchObject({ ok: false, error: expect.stringContaining('is invalid') });
    writeFileSync(path, JSON.stringify({ rule: [] }));
    expect(loadPolicy(path).ok).toBe(false);
    writeFileSync(path, '{');
    expect(loadPolicy(path)).toMatchObject({ ok: false, error: expect.stringContaining('not valid json') });
  });
});
