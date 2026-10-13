import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Result } from '../config/load.js';

export type Risk = 'read' | 'write' | 'external';
export type Decision = 'allow' | 'review' | 'approve' | 'deny';

const ruleSchema = z.object({
  // tool, session and each args value are patterns. a star matches any text, and case does not matter.
  tool: z.string().min(1),
  session: z.string().min(1).optional(),
  // each key is a top-level field of the tool input. an object value matches against its json text. a list
  // matches an allow rule only when each item matches.
  args: z.record(z.string(), z.string()).optional(),
  effect: z.enum(['allow', 'deny']),
  note: z.string().optional(),
})
  // a misspelled key such as "arg" must stop the start. without the key, the rule would match every call of the tool.
  .strict();

const policyFileSchema = z.object({ rules: z.array(ruleSchema).default([]) }).strict();

export type Rule = z.infer<typeof ruleSchema> & { id: string };

// these tools change only the local database or the memory files, or they message the owner. they do not need a
// review. a rule in okc.policy.json can still deny them, because the last matching rule wins.
const LOCAL_WRITE_TOOLS = [
  'automations_create',
  'automations_delete',
  'automations_update',
  'consolidation_save',
  'goal_update',
  'goals_set',
  'heartbeat_checklist_set',
  'heartbeat_respond',
  'memory_write',
  'message_owner',
];

export const BUILTIN_RULES: Rule[] = LOCAL_WRITE_TOOLS.map((tool) => ({
  id: `builtin:${tool}`,
  tool,
  effect: 'allow',
  note: 'the tool changes only local data',
}));

// a taint source names the first tool call that brought one untrusted source into a session. the owner can open
// that call to see why a later action needs approval.
export interface TaintSource {
  source: string;
  toolName: string;
  runId: string | null;
  toolCallId: string;
  at: string;
}

export interface PolicyInput {
  tool: string;
  risk: Risk;
  // the tool asks for approval on every call, also when a rule allows it.
  alwaysApprove: boolean;
  input: unknown;
  sessionKey: string;
  // the sources of untrusted content that the session read. an empty list means that the session is not tainted.
  taint: string[];
}

export interface Verdict {
  decision: Decision;
  // rule names what decided: a rule id, "taint", "tool", or "risk:<level>".
  rule: string;
  reason: string;
}

// a deny rule always wins. taint makes every external call go to the owner, also when a rule allows the tool.
// without a matching rule, the risk level decides.
export function decide(input: PolicyInput, rules: readonly Rule[]): Verdict {
  const rule = rules.findLast((each) => matches(each, input));
  if (rule?.effect === 'deny') {
    return { decision: 'deny', rule: rule.id, reason: rule.note ?? `the policy rule ${rule.id} denies ${input.tool}` };
  }
  if (input.alwaysApprove) {
    return { decision: 'approve', rule: 'tool', reason: `${input.tool} always needs the owner's approval` };
  }
  if (input.risk === 'external' && input.taint.length) {
    return {
      decision: 'approve',
      rule: 'taint',
      reason: `the session read untrusted content (${input.taint.join(', ')}), so an external action needs the owner's approval`,
    };
  }
  if (rule) return { decision: 'allow', rule: rule.id, reason: rule.note ?? `the policy rule ${rule.id} allows ${input.tool}` };
  switch (input.risk) {
    case 'read':
      return { decision: 'allow', rule: 'risk:read', reason: `${input.tool} only reads` };
    case 'write':
      return { decision: 'review', rule: 'risk:write', reason: `${input.tool} changes data, so a reviewer checks it first` };
    case 'external':
      return {
        decision: 'approve',
        rule: 'risk:external',
        reason: `${input.tool} sends data off the pc or changes an account, so the owner must approve it`,
      };
  }
}

function matches(rule: Rule, input: PolicyInput): boolean {
  if (!glob(rule.tool, input.tool)) return false;
  if (rule.session && !glob(rule.session, input.sessionKey)) return false;
  if (!rule.args) return true;
  const fields = input.input !== null && typeof input.input === 'object' ? (input.input as Record<string, unknown>) : {};
  return Object.entries(rule.args).every(([key, pattern]) => {
    const value = fields[key];
    if (value === undefined) return false;
    if (!Array.isArray(value)) return glob(pattern, text(value));
    // an allow rule must match each item of a list, so one good recipient cannot carry a bad one. a deny rule
    // matches when one item or the json text of the list matches.
    if (rule.effect === 'allow') return value.every((item) => glob(pattern, text(item)));
    return glob(pattern, text(value)) || value.some((item) => glob(pattern, text(item)));
  });
}

const text = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));

// the fold is the same as in a regular expression with the i flag. it never changes a character outside ascii into
// an ascii character, so the kelvin sign does not match the letter k in an allow rule.
function fold(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    const upper = char.toUpperCase();
    out += upper.length !== 1 || (char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? char : upper;
  }
  return out;
}

// a star matches any text, and case does not matter. the matcher goes back only to the last star, so its time is
// at most the product of both lengths. a regular expression with many stars can take minutes on a long argument.
export function glob(pattern: string, value: string): boolean {
  const p = fold(pattern);
  const v = fold(value);
  let pi = 0;
  let vi = 0;
  let star = -1;
  let resume = 0;
  while (vi < v.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++;
      resume = vi;
    } else if (pi < p.length && p[pi] === v[vi]) {
      pi++;
      vi++;
    } else if (star !== -1) {
      pi = star + 1;
      vi = ++resume;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// the policy file is optional. its rules come after the built-in rules, so a file rule can change them.
export function loadPolicy(path = 'okc.policy.json'): Result<Rule[]> {
  if (!existsSync(path)) return { ok: true, value: BUILTIN_RULES };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, error: `${path} is not valid json: ${(err as Error).message}` };
  }
  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `${path} is invalid:\n${z.prettifyError(parsed.error)}` };
  return { ok: true, value: [...BUILTIN_RULES, ...parsed.data.rules.map((rule, i) => ({ ...rule, id: `${path}#${i + 1}` }))] };
}

export interface ReviewRequest {
  runId: string;
  sessionKey: string;
  tool: string;
  input: unknown;
  risk: Risk;
  reason: string;
  taint: string[];
}

export interface ReviewResult {
  verdict: 'allow' | 'hold';
  reason: string;
  modelCallId?: number;
}

// the reviewer model comes in a later milestone. until then a review goes to the owner as an approval.
export type Reviewer = (request: ReviewRequest) => Promise<ReviewResult>;
