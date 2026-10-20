import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOLDEN_PATH, goldenCases, type Golden } from '../../scripts/autonomy-golden.js';
import { LADDER_CALLS } from '../../test/autonomy-calls.js';
import { domainOf, domainSpec } from './autonomy.js';
import { BUILTIN_RULES, decide } from './policy.js';

// the defaults of the trust ladder equal the behavior from before the ladder. the golden file holds the verdicts of
// the policy engine of master, before the ladder, and scripts/autonomy-golden.ts makes it. each case is decided here
// again with the level of its domain at the default, and the verdict must be the same.
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
const cases = goldenCases();

describe('the default levels of the trust ladder', () => {
  it('give each call the domain that the shared calls name', () => {
    for (const call of LADDER_CALLS) expect(domainOf(call.tool, call.input) ?? null, call.name).toBe(call.domain);
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
