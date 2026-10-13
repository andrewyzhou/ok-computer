import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES, decide, glob, loadPolicy, type PolicyInput, type Rule } from './policy.js';

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

  it('uses the matching rules, with patterns on the tool, the session and the arguments', () => {
    const rules = [
      rule('a', { tool: 'google__*', args: { from: '*@spam.example.com' }, effect: 'deny' }),
      rule('b', { tool: 'google__gmail_archive', args: { from: '*@letters.example.com' }, effect: 'allow', note: 'newsletters' }),
      rule('c', { tool: '*', session: 'heartbeat:*', effect: 'deny' }),
    ];
    expect(decide(call(), rules)).toEqual({ decision: 'allow', rule: 'b', reason: 'newsletters' });
    expect(decide(call({ input: { from: 'x@spam.example.com' } }), rules)).toMatchObject({ decision: 'deny', rule: 'a' });
    expect(decide(call({ input: { from: 'boss@work.example.com' } }), rules)).toMatchObject({ decision: 'review', rule: 'risk:write' });
    expect(decide(call({ sessionKey: 'heartbeat:run-1' }), rules)).toMatchObject({ decision: 'deny', rule: 'c' });
    expect(decide(call({ tool: 'now', risk: 'read' }), rules)).toMatchObject({ decision: 'allow', rule: 'risk:read' });
  });

  it('lets a deny rule win over an allow rule in any order', () => {
    const deny = rule('deny', { tool: 'send_*', args: { to: '*@evil.example' }, effect: 'deny' });
    const allow = rule('allow', { tool: 'send_email', effect: 'allow' });
    const send = (to: unknown) => call({ tool: 'send_email', risk: 'external', input: { to } });
    for (const rules of [
      [deny, allow],
      [allow, deny],
    ]) {
      expect(decide(send('x@evil.example'), rules)).toMatchObject({ decision: 'deny', rule: 'deny' });
      expect(decide(send(['ok@home.example', 'x@evil.example']), rules)).toMatchObject({ decision: 'deny', rule: 'deny' });
      expect(decide(send('ok@home.example'), rules)).toMatchObject({ decision: 'allow', rule: 'allow' });
    }
  });

  // an anchored deny pattern let common address forms out, and an allow rule for the tool then sent them.
  it('matches a deny pattern anywhere in the value, also in a display name, a list in one string, or an object', () => {
    const rules = [rule('allow', { tool: 'gmail_send', effect: 'allow' }), rule('deny', { tool: 'gmail_send', args: { to: '*@evil.example' }, effect: 'deny' })];
    const send = (to: unknown) => call({ tool: 'gmail_send', risk: 'external', input: { to } });
    for (const to of ['Eve <eve@evil.example>', 'eve@evil.example.', 'eve@evil.example ', 'eve@evil.example, a@home.example', [{ email: 'eve@evil.example' }]]) {
      expect(decide(send(to), rules)).toMatchObject({ decision: 'deny', rule: 'deny' });
    }
    expect(decide(send('Bob <bob@home.example>'), rules)).toMatchObject({ decision: 'allow', rule: 'allow' });
  });

  it('takes the reason from the last matching allow rule', () => {
    const rules = [rule('any', { tool: '*', effect: 'allow', note: 'any' }), rule('google', { tool: 'google__*', effect: 'allow', note: 'google' })];
    expect(decide(call(), rules)).toEqual({ decision: 'allow', rule: 'google', reason: 'google' });
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

  it('refuses a rule with an unknown key, because the rule would match every call of the tool', () => {
    const path = join(dir, 'typo.json');
    writeFileSync(path, JSON.stringify({ rules: [{ tool: 'gmail_archive', arg: { from: '*' }, effect: 'allow' }] }));
    expect(loadPolicy(path)).toMatchObject({ ok: false, error: expect.stringContaining('arg') });
  });
});

describe('rule patterns under hostile input', () => {
  // the old matcher was a regular expression. the new matcher must give the same answer on every input.
  const regex = (pattern: string) =>
    new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is');

  it('gives the same answers as a regular expression on random short inputs', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = (alphabet: string, max: number) =>
      Array.from({ length: Math.floor(random() * max) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    // the letters outside ascii have case pairs that a plain toLowerCase folds in a different way.
    const alphabet = 'abBA.\nkKKiIİıßſséÉ';
    for (let i = 0; i < 20_000; i++) {
      const pattern = pick(`${alphabet}**`, 7);
      const value = pick(alphabet, 9);
      expect(glob(pattern, value), `${JSON.stringify(pattern)} on ${JSON.stringify(value)}`).toBe(regex(pattern).test(value));
    }
  });

  it('does not let the kelvin sign match the letter k of an allow rule', () => {
    expect(glob('*@kelvin.example', 'eve@Kelvin.example')).toBe(false);
    expect(glob('*@KELVIN.example', 'eve@kelvin.EXAMPLE')).toBe(true);
  });

  it('matches many stars against a long argument quickly', () => {
    const started = performance.now();
    expect(glob('*a*a*a*a*a*a*b', 'a'.repeat(20_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('allows a list only when each item matches, and denies it when one item matches', () => {
    const allow = [rule('me', { tool: 'send', args: { to: '*@me.example' }, effect: 'allow' })];
    const send = (to: unknown) => call({ tool: 'send', input: { to } });
    expect(decide(send(['a@me.example', 'b@me.example']), allow)).toMatchObject({ decision: 'allow' });
    expect(decide(send(['a@me.example', 'eve@evil.example']), allow)).toMatchObject({ decision: 'review' });
    const deny = [rule('evil', { tool: 'send', args: { to: '*@evil.example' }, effect: 'deny' })];
    expect(decide(send(['a@me.example', 'eve@evil.example']), deny)).toMatchObject({ decision: 'deny' });
  });
});
