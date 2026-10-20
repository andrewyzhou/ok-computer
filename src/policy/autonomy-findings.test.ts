import { describe, expect, it } from 'vitest';
import { domainOf, formIsPurchase, isPurchase, type AutonomyDomain, type AutonomyLevel } from './autonomy.js';
import { BUILTIN_RULES, decide, type PolicyInput } from './policy.js';

// the gaps that the review of the trust ladder found: a purchase through a browser form, a raise that reached a
// sub-agent and a level that is not one of the three. src/autonomy/tools.test.ts has the lowering from a tainted chat.

const submitOf = (fields: Record<string, string>, button: string): PolicyInput => {
  const input = { url: 'https://shop.example/checkout', button, fields };
  return { tool: 'browser_submit', risk: 'external', alwaysApprove: true, input, sessionKey: 'automation:a-1', taint: [], seen: () => false, autonomy: { domain: domainOf('browser_submit', input)!, level: 'review' } };
};

const submit = (input: { url: string; button: string; fields: Record<string, string | string[]> }, sessionKey: string, level: AutonomyLevel): PolicyInput => ({
  tool: 'browser_submit',
  risk: 'external',
  alwaysApprove: true,
  input,
  sessionKey,
  taint: [],
  seen: () => false,
  autonomy: { domain: domainOf('browser_submit', input)!, level },
});

describe('purchases', () => {
  it('keeps a purchase through a browser form at ask, also when the owner raised browser submits to review', () => {
    const verdict = decide(submitOf({ quantity: '1', payment: 'saved card ending 4242' }, 'Place order'), BUILTIN_RULES);
    expect(verdict.decision).toBe('approve');
  });

  it('puts a checkout submit in purchases, which asks the owner in an untainted automation at a raised browser submits level', () => {
    const input = { url: 'https://shop.example/checkout', button: 'Place order', fields: { card: '4111' } };
    expect(domainOf('browser_submit', input)).toBe('purchases');
    // the level that the owner gave browser submits does not apply to the purchase: purchases stays at ask.
    const verdict = decide(submit(input, 'automation:a-1', 'ask'), BUILTIN_RULES);
    expect(verdict).toMatchObject({ decision: 'approve', autonomy: { domain: 'purchases', level: 'ask' } });
    // a hand-edited level of purchases above ask counts as ask.
    expect(decide(submit(input, 'automation:a-1', 'review'), BUILTIN_RULES).decision).toBe('approve');
    expect(decide(submit(input, 'automation:a-1', 'auto'), BUILTIN_RULES).decision).toBe('approve');
  });

  it('takes a submit for a purchase when its page, its button or a field names a payment, or a value is a card number', () => {
    const base: { url: string; button: string; fields: Record<string, string | string[]> } = { url: 'https://example.com/form', button: 'Send', fields: { name: 'Ana' } };
    const cases: Array<[string, Partial<typeof base>]> = [
      ['a checkout page', { url: 'https://shop.example/cart/checkout?step=2' }],
      ['a pay page', { url: 'https://example.com/pay' }],
      ['place order', { button: 'Place order' }],
      ['buy now', { button: 'Buy now' }],
      ['add to cart', { button: 'Add to cart' }],
      ['subscribe', { button: 'Subscribe for $5' }],
      ['a card number field', { fields: { cardNumber: 'x' } }],
      ['an autocomplete name', { fields: { 'cc-exp': '12/29' } }],
      ['a cvc field', { fields: { cvc: '123' } }],
      ['a card number value', { fields: { number: '4111 1111 1111 1111' } }],
      ['a card number in a list', { fields: { number: ['x', '4111-1111-1111-1111'] } }],
      ['no field: a button outside a form', { fields: {} }],
    ];
    for (const [name, change] of cases) expect(isPurchase({ ...base, ...change }), name).toBe(true);
  });

  // the probe of the review: with browser submits raised to review in an untainted automation, each of these paid
  // flows went to the reviewer alone.
  const PAID_FLOWS: Array<[string, { url: string; button: string; fields: Record<string, string> }]> = [
    ['a room booking', { url: 'https://hotel.example/rooms/12/booking', button: 'Book now', fields: { guests: '2', name: 'Ana', email: 'ana@example.com' } }],
    ['a reservation', { url: 'https://inn.example/reserve', button: 'Reserve', fields: { nights: '3', note: 'late arrival' } }],
    ['a shop checkout with a plural path', { url: 'https://shop.example/checkouts/c/abc', button: 'Complete', fields: { note: 'x' } }],
    ['a last step that only confirms', { url: 'https://shop.example/step/3', button: 'Confirm', fields: { delivery: 'standard', gift_message: 'happy birthday' } }],
    ['a flight', { url: 'https://air.example/flights/confirm', button: 'Book flight', fields: { passenger: 'Ana' } }],
    ['event tickets', { url: 'https://events.example/event/9', button: 'Get tickets', fields: { quantity: '2' } }],
  ];

  it('takes each paid flow of the review probe for a purchase, which asks the owner at a raised browser submits level', () => {
    for (const [name, input] of PAID_FLOWS) {
      expect(domainOf('browser_submit', input), name).toBe('purchases');
      // the helper hands the raised level of browser submits to the call, and purchases counts any level as ask.
      expect(decide(submit(input, 'automation:a1', 'review'), BUILTIN_RULES), name).toMatchObject({ decision: 'approve', autonomy: { domain: 'purchases' } });
    }
  });

  it('takes a call that the agent marks as a purchase for one', () => {
    const input = { url: 'https://example.com/signup', button: 'Sign up', fields: { email: 'owner@example.com' }, purchase: true };
    expect(domainOf('browser_submit', input)).toBe('purchases');
    expect(domainOf('browser_submit', { ...input, purchase: false })).toBe('browser_submits');
  });

  it('reads the hidden fields, the address and the script of the whole form', () => {
    const base = { url: 'https://example.com/signup', button: 'Sign up', action: 'https://example.com/signup', script: false };
    const plain: Array<[string, string]> = [['email', 'owner@example.com'], ['csrf', 'a1b2']];
    expect(formIsPurchase({ ...base, pairs: plain })).toBe(false);
    expect(formIsPurchase({ ...base, pairs: [...plain, ['payment_method_id', 'pm_1']] }), 'a hidden payment token').toBe(true);
    expect(formIsPurchase({ ...base, pairs: [...plain, ['saved', 'card_on_file']] }), 'a hidden value').toBe(true);
    expect(formIsPurchase({ ...base, pairs: plain, action: 'https://example.com/orders/new' }), 'the address of the form').toBe(true);
    expect(formIsPurchase({ ...base, pairs: plain, script: true }), 'a script control').toBe(true);
    expect(formIsPurchase({ ...base, pairs: [] }), 'no field').toBe(true);
  });

  it('leaves a plain sign-up and a search in browser submits', () => {
    expect(domainOf('browser_submit', { url: 'https://example.com/signup', button: 'Sign up', fields: { email: 'owner@example.com' } })).toBe('browser_submits');
    expect(domainOf('browser_submit', { url: 'https://example.com/search', button: 'Search', fields: { q: 'weather in Berkeley' } })).toBe('browser_submits');
  });
});

describe('a raise and the sub-agents', () => {
  const network = { language: 'python', code: 'print(1)', network: { allow: ['pypi.org'] } };
  const exec = (sessionKey: string, level: AutonomyLevel): PolicyInput => ({
    tool: 'sandbox_exec',
    risk: 'external',
    alwaysApprove: true,
    input: network,
    sessionKey,
    taint: [],
    seen: () => false,
    autonomy: { domain: 'sandbox_network', level },
  });
  const signup = { url: 'https://example.com/signup', button: 'Sign up', fields: { email: 'owner@example.com' } };

  it('keeps networked code of a sub-agent denied when the owner raised code with network access to review', () => {
    const ask = decide(exec('sub:research:r1', 'ask'), BUILTIN_RULES);
    const review = decide(exec('sub:research:r1', 'review'), BUILTIN_RULES);
    expect(ask).toMatchObject({ decision: 'deny', rule: 'subagent' });
    expect(review).toMatchObject({ decision: 'deny', rule: 'subagent', autonomy: { domain: 'sandbox_network', level: 'review' } });
    // the owner chat and an automation do get the raise.
    expect(decide(exec('main', 'review'), BUILTIN_RULES)).toMatchObject({ decision: 'review', rule: 'autonomy:sandbox_network' });
    expect(decide(exec('automation:a-1', 'review'), BUILTIN_RULES)).toMatchObject({ decision: 'review', rule: 'autonomy:sandbox_network' });
  });

  it('keeps a form submit of a sub-agent denied when the owner raised browser submits to review', () => {
    expect(decide(submit(signup, 'sub:browser:r2', 'review'), BUILTIN_RULES)).toMatchObject({ decision: 'deny', rule: 'subagent' });
    expect(decide(submit(signup, 'main', 'review'), BUILTIN_RULES)).toMatchObject({ decision: 'review', rule: 'autonomy:browser_submits' });
  });

  it('keeps a lowered level of a review domain for a sub-agent', () => {
    const input = { account: 'personal', to: ['ana@example.com'], subject: 'x', body: 'x' };
    const verdict = decide(
      { tool: 'google__gmail_draft', risk: 'write', alwaysApprove: false, input, sessionKey: 'sub:research:r1', taint: [], seen: () => false, autonomy: { domain: 'mail_drafts', level: 'ask' } },
      BUILTIN_RULES,
    );
    expect(verdict).toMatchObject({ decision: 'deny', rule: 'subagent' });
  });
});

describe('a level that is not one of the three', () => {
  it('never counts a level that is not one of the three as more freedom', () => {
    const input = { account: 'personal', to: ['ana@example.com'], subject: 'x', body: 'x' };
    for (const level of ['AUTO', 'Auto', 'yolo', '']) {
      const verdict = decide({ tool: 'google__gmail_draft', risk: 'write', alwaysApprove: false, input, sessionKey: 'main', taint: [], seen: () => false, autonomy: { domain: 'mail_drafts', level: level as never } }, BUILTIN_RULES);
      expect(verdict.decision, level).not.toBe('allow');
    }
  });

  it('counts it as ask, also in a domain whose default is ask', () => {
    const domains: AutonomyDomain[] = ['mail_drafts', 'mail_labels', 'calendar_holds'];
    for (const domain of domains) {
      const verdict = decide(
        { tool: 'x', risk: 'write', alwaysApprove: false, input: {}, sessionKey: 'main', taint: [], seen: () => false, autonomy: { domain, level: 'REVIEW' as never } },
        BUILTIN_RULES,
      );
      expect(verdict, domain).toMatchObject({ decision: 'approve', rule: `autonomy:${domain}` });
    }
    const exec = decide(
      { tool: 'sandbox_exec', risk: 'external', alwaysApprove: true, input: {}, sessionKey: 'main', taint: [], seen: () => false, autonomy: { domain: 'sandbox_network', level: 'yolo' as never } },
      BUILTIN_RULES,
    );
    expect(exec).toMatchObject({ decision: 'approve', rule: 'tool' });
  });
});
