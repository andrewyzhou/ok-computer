import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOLDEN_PATH, goldenCases, type Golden } from '../../scripts/autonomy-golden.js';
import { LADDER_CALLS, PHASE6_LADDER_CALLS } from '../../test/autonomy-calls.js';
import { domainOf, domainSpec } from './autonomy.js';
import { BUILTIN_RULES, decide } from './policy.js';

// the defaults of the trust ladder equal the behavior from before the ladder. the golden file holds the verdicts of
// the policy engine of master, before the ladder, and scripts/autonomy-golden.ts makes it. each case is decided here
// again with the level of its domain at the default, and the verdict must be the same.
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
const cases = goldenCases();

describe('the default levels of the trust ladder', () => {
  it('give each call the domain that the shared calls name', () => {
    for (const call of [...LADDER_CALLS, ...PHASE6_LADDER_CALLS]) expect(domainOf(call.tool, call.input) ?? null, call.name).toBe(call.domain);
  });

  // the tools of phase 6 have no verdict in the engine of master, so the verdict without the ladder comes from the
  // current engine with no domain for the call.
  it.each(goldenCases(PHASE6_LADDER_CALLS).map((each) => [each.key, each] as const))('give a tool of phase 6 the verdict without the ladder: %s', (_key, each) => {
    const domain = domainOf(each.call.tool, each.call.input);
    const autonomy = domain ? { domain, level: domainSpec(domain).defaultLevel } : undefined;
    const rules = each.rules(BUILTIN_RULES);
    const { decision, rule, reason } = decide({ ...each.input, ...(autonomy ? { autonomy } : {}) }, rules);
    const without = decide(each.input, rules);
    expect({ decision, rule, reason }).toEqual({ decision: without.decision, rule: without.rule, reason: without.reason });
  });

  it('have a golden verdict for each case, and no golden verdict without a case', () => {
    // a new call in LADDER_CALLS needs a new golden file from scripts/autonomy-golden.ts.
    expect(Object.keys(golden).sort()).toEqual(cases.map((each) => each.key).sort());
    expect(new Set(cases.map((each) => each.key)).size).toBe(cases.length);
  });

  it.each(cases.map((each) => [each.key, each] as const))('give the verdict from before the ladder: %s', (_key, each) => {
    const domain = domainOf(each.call.tool, each.call.input);
    const autonomy = domain ? { domain, level: domainSpec(domain).defaultLevel } : undefined;
    const verdict = decide({ ...each.input, ...(autonomy ? { autonomy } : {}) }, each.rules(BUILTIN_RULES));
    const { decision, rule, reason } = verdict;
    expect({ decision, rule, reason }).toEqual(golden[each.key]);
    // the verdict keeps the level that applied, so the trace records it.
    expect(verdict.autonomy).toEqual(autonomy);
  });
});
