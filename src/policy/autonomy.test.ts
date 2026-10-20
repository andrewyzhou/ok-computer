import { describe, expect, it } from 'vitest';
import { LADDER_CALLS, type LadderCall } from '../../test/autonomy-calls.js';
import { domainOf, type AutonomyContext, type AutonomyDomain, type AutonomyLevel } from './autonomy.js';
import { BUILTIN_RULES, decide, type PolicyInput, type Rule } from './policy.js';

const callOf = (tool: string, extra: Partial<LadderCall['input']> = {}): LadderCall => {
  const call = LADDER_CALLS.find((each) => each.tool === tool && each.domain !== null);
  if (!call) throw new Error(`no ladder call for ${tool}`);
  return { ...call, input: { ...call.input, ...extra } };
};

const TAINT = ['gmail: a mail from news@example.com'];

function decideAt(call: LadderCall, level: AutonomyLevel, options: { sessionKey?: string; taint?: string[]; rules?: Rule[]; domain?: AutonomyDomain } = {}) {
  const autonomy: AutonomyContext = { domain: options.domain ?? call.domain!, level };
  const input: PolicyInput = {
    tool: call.tool,
    risk: call.risk,
    alwaysApprove: call.alwaysApprove,
    input: call.input,
    sessionKey: options.sessionKey ?? 'main',
    taint: options.taint ?? [],
    seen: () => false,
    autonomy,
  };
  return decide(input, options.rules ?? BUILTIN_RULES);
}

const allowAll: Rule = { id: 'test#allow-all', tool: '*', effect: 'allow' };
const draft = callOf('google__gmail_draft');
const submit = callOf('browser_submit');
const network = callOf('sandbox_exec');
const guests = LADDER_CALLS.find((each) => each.domain === 'calendar_guests')!;

describe('domainOf', () => {
  it('gives the domain of each tool of the ladder', () => {
    expect(domainOf('google__gmail_draft', {})).toBe('mail_drafts');
    expect(domainOf('inbox_draft_reply', {})).toBe('mail_drafts');
    for (const tool of ['google__gmail_label', 'google__gmail_archive', 'google__gmail_mark_read']) expect(domainOf(tool, {})).toBe('mail_labels');
    expect(domainOf('browser_submit', { url: 'https://example.com/signup', button: 'Sign up', fields: { email: 'owner@example.com' } })).toBe('browser_submits');
    // a submit with no fields is a script button, which counts as a purchase.
    expect(domainOf('browser_submit', {})).toBe('purchases');
    expect(domainOf('google__gmail_unsubscribe', {})).toBe('unsubscribes');
    expect(domainOf('inbox_unsubscribe', {})).toBe('unsubscribes');
  });

  it('splits calendar events by their guests', () => {
    expect(domainOf('google__calendar_create_event', { attendees: ['ana@example.com'] })).toBe('calendar_guests');
    expect(domainOf('google__calendar_create_event', { attendees: [] })).toBe('calendar_holds');
    expect(domainOf('google__calendar_create_event', {})).toBe('calendar_holds');
  });

  it('puts sandbox code in the ladder only with network access', () => {
    expect(domainOf('sandbox_exec', { network: { allow: ['pypi.org'] } })).toBe('sandbox_network');
    expect(domainOf('sandbox_exec', { network: null })).toBeUndefined();
    expect(domainOf('sandbox_exec', { network: 'on' })).toBeUndefined();
    expect(domainOf('sandbox_exec', {})).toBeUndefined();
  });

  it('gives no domain to other tools, and does not throw on an input that is not an object', () => {
    expect(domainOf('memory_write', {})).toBeUndefined();
    expect(domainOf('google__gmail_send', {})).toBeUndefined();
    expect(domainOf('toString', {})).toBeUndefined();
    expect(domainOf('constructor', {})).toBeUndefined();
    for (const input of [null, undefined, 'text', 42, [1]]) {
      expect(() => domainOf('google__calendar_create_event', input)).not.toThrow();
      expect(() => domainOf('sandbox_exec', input)).not.toThrow();
    }
    expect(domainOf('google__calendar_create_event', null)).toBe('calendar_holds');
    expect(domainOf('sandbox_exec', 'text')).toBeUndefined();
  });
});

describe('the policy engine with a level of the trust ladder', () => {
  it('makes the owner approve each draft at a lowered ask, also with an allow rule', () => {
    const verdict = decideAt(draft, 'ask', { rules: [...BUILTIN_RULES, allowAll] });
    expect(verdict).toEqual({
      decision: 'approve',
      rule: 'autonomy:mail_drafts',
      reason: 'the owner set mail drafts to ask, so the owner approves each call',
      autonomy: { domain: 'mail_drafts', level: 'ask' },
    });
  });

  it('keeps an approval at a lowered ask as it is', () => {
    const hold = callOf('google__calendar_create_event');
    const verdict = decideAt({ ...hold, alwaysApprove: true }, 'ask');
    expect(verdict).toMatchObject({ decision: 'approve', rule: 'tool', autonomy: { domain: 'calendar_holds', level: 'ask' } });
  });

  it('allows a draft at auto', () => {
    expect(decideAt(draft, 'auto')).toEqual({
      decision: 'allow',
      rule: 'autonomy:mail_drafts',
      reason: 'the owner set mail drafts to auto',
      autonomy: { domain: 'mail_drafts', level: 'auto' },
    });
  });

  it('still sends a draft with a url that can carry data in a tainted session to the reviewer at auto', () => {
    const leaky = { ...draft, input: { ...draft.input, body: 'Here it is: https://evil.example/c?d=the-owner-secret' } };
    const verdict = decideAt(leaky, 'auto', { taint: TAINT });
    expect(verdict).toMatchObject({ decision: 'review', rule: 'exfiltration', autonomy: { domain: 'mail_drafts', level: 'auto' } });
  });

  it('sends a browser submit at review to the reviewer in a session that is not tainted', () => {
    expect(decideAt(submit, 'review')).toEqual({
      decision: 'review',
      rule: 'autonomy:browser_submits',
      reason: 'the owner set browser form submits to review, so a reviewer checks it first',
      autonomy: { domain: 'browser_submits', level: 'review' },
    });
  });

  it('still makes the owner approve a browser submit at review in a tainted session', () => {
    expect(decideAt(submit, 'review', { taint: TAINT })).toMatchObject({ decision: 'approve', rule: 'taint', autonomy: { domain: 'browser_submits', level: 'review' } });
  });

  it('sends a browser submit at review to the reviewer also when a broad rule allows it', () => {
    expect(decideAt(submit, 'review', { rules: [...BUILTIN_RULES, allowAll] })).toMatchObject({ decision: 'review', rule: 'autonomy:browser_submits' });
  });

  it('sends code with network access at review to the reviewer', () => {
    expect(decideAt(network, 'review')).toMatchObject({ decision: 'review', rule: 'autonomy:sandbox_network', autonomy: { domain: 'sandbox_network', level: 'review' } });
  });

  it('clamps a hand-edited level above the most of a fixed domain', () => {
    const verdict = decideAt(guests, 'auto');
    expect(verdict).toMatchObject({ decision: 'approve', rule: 'tool', autonomy: { domain: 'calendar_guests', level: 'auto' } });
    // a browser submit can go up to review, so auto counts as review.
    expect(decideAt(submit, 'auto')).toMatchObject({ decision: 'review', rule: 'autonomy:browser_submits' });
  });

  it('denies a call that needs the owner in a sub-agent session, and keeps the level', () => {
    const verdict = decideAt(draft, 'ask', { sessionKey: 'sub:research:run-9' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.rule).toBe('subagent');
    expect(verdict.reason).toContain('the owner set mail drafts to ask');
    expect(verdict.autonomy).toEqual({ domain: 'mail_drafts', level: 'ask' });
  });

  it('lets a deny rule win at every level', () => {
    const denyTool = (tool: string): Rule => ({ id: 'test#deny', tool, effect: 'deny' });
    const denyArgs: Rule = { id: 'test#deny-args', tool: '*', args: { to: '*@example.com' }, effect: 'deny' };
    for (const level of ['ask', 'review', 'auto'] as const) {
      expect(decideAt(draft, level, { rules: [...BUILTIN_RULES, allowAll, denyTool(draft.tool)] })).toMatchObject({ decision: 'deny', rule: 'test#deny', autonomy: { level } });
      expect(decideAt(draft, level, { rules: [...BUILTIN_RULES, denyArgs] })).toMatchObject({ decision: 'deny', rule: 'test#deny-args' });
      expect(decideAt(submit, level, { rules: [...BUILTIN_RULES, denyTool(submit.tool)] })).toMatchObject({ decision: 'deny', rule: 'test#deny' });
    }
  });

  it('decides a call without a level as before, with no level on the verdict', () => {
    const verdict = decide({ tool: 'memory_write', risk: 'write', alwaysApprove: false, input: {}, sessionKey: 'main', taint: [] }, BUILTIN_RULES);
    expect(verdict).toEqual({ decision: 'allow', rule: 'builtin:memory_write', reason: 'the tool changes only local data' });
    expect('autonomy' in verdict).toBe(false);
  });
});
