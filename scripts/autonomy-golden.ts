import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PolicyInput, Rule, Verdict } from '../src/policy/policy.js';
import { LADDER_CALLS, LADDER_SESSIONS, type LadderCall } from '../test/autonomy-calls.js';

// the golden file of the equivalence test of the trust ladder (src/policy/autonomy-equivalence.test.ts). it holds the
// verdict of the policy engine from before the ladder for each call of LADDER_CALLS, in each session of
// LADDER_SESSIONS, with each rule set below. the test decides the same cases with the default levels and compares.
//
// run it with `npx tsx scripts/autonomy-golden.ts [ref]`. ref is the git ref of the engine from before the ladder, and
// master is the default. the script copies src/policy/policy.ts of that ref next to the current one for the run, so
// its imports resolve, and removes the copy at the end. a new call in LADDER_CALLS needs a new golden file.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GOLDEN_PATH = join(ROOT, 'src/policy/autonomy-equivalence.golden.json');

export interface RuleSet {
  name: string;
  rules: (builtin: readonly Rule[], call: LadderCall) => Rule[];
}

// the rule sets: the built-in rules alone, a broad allow rule, an allow rule and a deny rule on the exact tool, and a
// deny rule on the arguments.
export const RULE_SETS: readonly RuleSet[] = [
  { name: 'builtin', rules: (builtin) => [...builtin] },
  { name: 'allow all', rules: (builtin) => [...builtin, { id: 'test#allow-all', tool: '*', effect: 'allow' }] },
  { name: 'allow tool', rules: (builtin, call) => [...builtin, { id: 'test#allow-tool', tool: call.tool, effect: 'allow' }] },
  { name: 'deny tool', rules: (builtin, call) => [...builtin, { id: 'test#deny-tool', tool: call.tool, effect: 'deny' }] },
  { name: 'deny args', rules: (builtin) => [...builtin, { id: 'test#deny-args', tool: '*', args: { to: '*@example.com' }, effect: 'deny' }] },
];

export interface GoldenCase {
  key: string;
  call: LadderCall;
  input: PolicyInput;
  rules: (builtin: readonly Rule[]) => Rule[];
}

export type Golden = Record<string, Pick<Verdict, 'decision' | 'rule' | 'reason'>>;

// each case once, with a key that names the call, the session and the rule set. no url counts as read.
export function goldenCases(): GoldenCase[] {
  return LADDER_CALLS.flatMap((call) =>
    LADDER_SESSIONS.flatMap((session) =>
      RULE_SETS.map((set) => ({
        key: `${call.name} | ${session.name} | ${set.name}`,
        call,
        input: {
          tool: call.tool,
          risk: call.risk,
          alwaysApprove: call.alwaysApprove,
          input: call.input,
          sessionKey: session.sessionKey,
          taint: [...session.taint],
          seen: () => false,
        },
        rules: (builtin: readonly Rule[]) => set.rules(builtin, call),
      })),
    ),
  );
}

interface Engine {
  decide: (input: PolicyInput, rules: readonly Rule[]) => Verdict;
  BUILTIN_RULES: Rule[];
}

async function main(ref: string): Promise<void> {
  const source = execFileSync('git', ['show', `${ref}:src/policy/policy.ts`], { cwd: ROOT, encoding: 'utf8' });
  const copy = join(ROOT, 'src/policy/.policy-before-ladder.ts');
  writeFileSync(copy, source);
  try {
    const engine = (await import(pathToFileURL(copy).href)) as Engine;
    const golden: Golden = {};
    for (const each of goldenCases()) {
      const { decision, rule, reason } = engine.decide(each.input, each.rules(engine.BUILTIN_RULES));
      golden[each.key] = { decision, rule, reason };
    }
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`);
    console.log(`wrote ${Object.keys(golden).length} cases from ${ref} to ${GOLDEN_PATH}`);
  } finally {
    rmSync(copy, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2] ?? 'master');
}
