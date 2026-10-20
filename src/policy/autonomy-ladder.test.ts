import { describe, expect, it } from 'vitest';
import { goldenCases } from '../../scripts/autonomy-golden.js';
import { PHASE6_LADDER_CALLS } from '../../test/autonomy-calls.js';
import { DOMAINS, domainOf, domainSpec, LEVELS, levelRank, type AutonomyLevel } from './autonomy.js';
import { BUILTIN_RULES, decide, type Decision, type Verdict } from './policy.js';

// properties of the trust ladder over every shared call, session and rule set of the equivalence test, and at every
// level, also the levels that only a hand edit of the database can store. a level must change only how strict the
// engine is, in the order of the ladder, and never past the checks that sit outside the ladder.

// how strict a decision is. deny is the most strict, and allow the least.
const STRICT: Record<Decision, number> = { deny: 3, approve: 2, review: 1, allow: 0 };

const cases = [...goldenCases(), ...goldenCases(PHASE6_LADDER_CALLS)].filter((each) => domainOf(each.call.tool, each.call.input) !== undefined);

function at(each: (typeof cases)[number], level: AutonomyLevel): Verdict {
  const domain = domainOf(each.call.tool, each.call.input)!;
  return decide({ ...each.input, autonomy: { domain, level } }, each.rules(BUILTIN_RULES));
}

describe('the levels of the trust ladder over every shared call', () => {
  it('has cases in each domain that has tools', () => {
    const seen = new Set(cases.map((each) => domainOf(each.call.tool, each.call.input)));
    for (const spec of DOMAINS) if (spec.tools.length) expect(seen.has(spec.id), spec.id).toBe(true);
  });

  it('never makes a higher level more strict than a lower one', () => {
    for (const each of cases) {
      const strict = LEVELS.map((level) => STRICT[at(each, level).decision]);
      for (let i = 1; i < strict.length; i++) expect(strict[i]!, `${each.key}: ${LEVELS[i]}`).toBeLessThanOrEqual(strict[i - 1]!);
    }
  });

  it('never makes a level below the default looser than the default, nor a level above it stricter', () => {
    for (const each of cases) {
      const spec = domainSpec(domainOf(each.call.tool, each.call.input)!);
      const base = STRICT[at(each, spec.defaultLevel).decision];
      for (const level of LEVELS) {
        const strict = STRICT[at(each, level).decision];
        if (levelRank(level) < levelRank(spec.defaultLevel)) expect(strict, `${each.key}: ${level}`).toBeGreaterThanOrEqual(base);
        if (levelRank(level) > levelRank(spec.defaultLevel)) expect(strict, `${each.key}: ${level}`).toBeLessThanOrEqual(base);
      }
    }
  });

  it('keeps every call of a fixed domain at its default verdict at every stored level', () => {
    for (const each of cases) {
      const spec = domainSpec(domainOf(each.call.tool, each.call.input)!);
      if (spec.fixedReason === null) continue;
      const base = at(each, 'ask');
      for (const level of LEVELS) {
        const verdict = at(each, level);
        expect({ decision: verdict.decision, rule: verdict.rule }, `${each.key}: ${level}`).toEqual({ decision: base.decision, rule: base.rule });
      }
    }
  });

  it('never goes looser than the most of a domain, also for a hand-edited level above it', () => {
    for (const each of cases) {
      const spec = domainSpec(domainOf(each.call.tool, each.call.input)!);
      const most = STRICT[at(each, spec.maxLevel).decision];
      for (const level of LEVELS) expect(STRICT[at(each, level).decision], `${each.key}: ${level}`).toBeGreaterThanOrEqual(most);
    }
  });

  it('lets a call run without any check only at auto, in a domain that allows auto', () => {
    for (const each of cases) {
      const spec = domainSpec(domainOf(each.call.tool, each.call.input)!);
      for (const level of LEVELS) {
        const verdict = at(each, level);
        if (verdict.rule.startsWith('autonomy:') && verdict.decision === 'allow') {
          expect(level, each.key).toBe('auto');
          expect(spec.maxLevel, each.key).toBe('auto');
        }
      }
    }
  });

  it('keeps a deny, the taint and a sub-agent refusal at every level', () => {
    for (const each of cases) {
      const base = at(each, domainSpec(domainOf(each.call.tool, each.call.input)!).defaultLevel);
      for (const level of LEVELS) {
        const verdict = at(each, level);
        if (base.decision === 'deny' && base.rule !== 'subagent') expect(verdict, `${each.key}: ${level}`).toMatchObject({ decision: 'deny', rule: base.rule });
        // the taint is outside the ladder: a raise must still ask the owner for an external call, and still send a
        // local write that later runs read back (person_note) to the reviewer.
        if (base.rule === 'taint' && levelRank(level) >= levelRank(domainSpec(domainOf(each.call.tool, each.call.input)!).defaultLevel)) {
          expect(verdict, `${each.key}: ${level}`).toMatchObject({ decision: base.decision, rule: 'taint' });
        }
      }
    }
  });

  it('records the stored level and the domain on each verdict, also when the level was clamped', () => {
    for (const each of cases) {
      const domain = domainOf(each.call.tool, each.call.input)!;
      for (const level of LEVELS) expect(at(each, level).autonomy, `${each.key}: ${level}`).toEqual({ domain, level });
    }
  });

  it('never lets a sub-agent reach the owner, at any level', () => {
    for (const each of cases.filter((one) => one.input.sessionKey.startsWith('sub:'))) {
      for (const level of LEVELS) expect(at(each, level).decision, `${each.key}: ${level}`).not.toBe('approve');
    }
  });
});

describe('a level for a domain that the list does not know', () => {
  it('throws, so the tool caller takes the path of a failed check and the tool does not run', () => {
    const each = cases[0]!;
    expect(() => decide({ ...each.input, autonomy: { domain: 'mail_everything' as never, level: 'auto' } }, BUILTIN_RULES)).toThrow(/unknown autonomy domain/);
  });
});
