import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Result } from '../config/load.js';
import { headOf } from '../text.js';

export type Risk = 'read' | 'write' | 'external';
export type Decision = 'allow' | 'review' | 'approve' | 'deny';

const ruleSchema = z.object({
  // tool, session and each args value are patterns. a star matches any text, and case does not matter.
  tool: z.string().min(1),
  session: z.string().min(1).optional(),
  // each key is a top-level field of the tool input. an object value matches against its json text. a list
  // matches an allow rule only when each item matches. a deny pattern matches anywhere in the text. a star in an allow
  // pattern also matches a comma or a ".." segment, so a field with several recipients must be a list in the schema.
  args: z.record(z.string(), z.string()).optional(),
  effect: z.enum(['allow', 'deny']),
  note: z.string().optional(),
})
  // a misspelled key such as "arg" must stop the start. without the key, the rule would match every call of the tool.
  .strict();

const policyFileSchema = z.object({ rules: z.array(ruleSchema).default([]) }).strict();

export type Rule = z.infer<typeof ruleSchema> & { id: string };

// these tools change only the local database or the memory files, or they message the owner. they do not need a
// review. a rule in okc.policy.json can still deny them, because a deny rule always wins.
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

export const BUILTIN_RULES: Rule[] = [
  ...LOCAL_WRITE_TOOLS.map((tool): Rule => ({ id: `builtin:${tool}`, tool, effect: 'allow', note: 'the tool changes only local data' })),
  { id: 'builtin:delegate', tool: 'delegate', effect: 'allow', note: 'delegate starts a sub-agent; each call of the sub-agent gets its own policy decision' },
];

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
  // seen tells whether a url is in the text that the session already read. the policy asks only in a tainted session,
  // and only for a url that can carry data.
  seen?: (url: string) => boolean;
}

// a sub-agent runs in a session sub:<profile>:<childRunId>. no run reads the result of an approval in that session,
// and the owner did not start the child, so a child never asks the owner. the parent can ask for the same call.
export const SUBAGENT_PREFIX = 'sub:';

export interface Verdict {
  decision: Decision;
  // rule names what decided: a rule id, "taint", "exfiltration", "subagent", "tool", or "risk:<level>".
  rule: string;
  reason: string;
}

// a deny rule always wins, in any position in the file. so a broad allow rule that comes later cannot cancel a deny
// rule. taint makes every external call go to the owner, also when a rule allows the tool. without a matching rule,
// the risk level decides. in a sub-agent session a call that needs the owner is denied.
export function decide(input: PolicyInput, rules: readonly Rule[]): Verdict {
  const verdict = decideAny(input, rules);
  if (verdict.decision !== 'approve' || !input.sessionKey.startsWith(SUBAGENT_PREFIX)) return verdict;
  const [, profile, childRunId] = input.sessionKey.split(':');
  return {
    decision: 'deny',
    rule: 'subagent',
    reason: `${verdict.reason}, but the ${profile} sub-agent (run ${childRunId}) cannot ask the owner. Report this call to the parent agent, so that the parent agent makes it`,
  };
}

function decideAny(input: PolicyInput, rules: readonly Rule[]): Verdict {
  const deny = rules.find((each) => each.effect === 'deny' && matches(each, input));
  if (deny) return { decision: 'deny', rule: deny.id, reason: deny.note ?? `the policy rule ${deny.id} denies ${input.tool}` };
  const rule = rules.findLast((each) => each.effect === 'allow' && matches(each, input));
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
  // in a tainted session an injected instruction can make the model put private data in a link or a search. the
  // reviewer checks such a call, also when a rule allows the tool, because a rule cannot see the data in the call.
  const leak = input.taint.length ? dataLeak(input) : undefined;
  if (leak) {
    return {
      decision: 'review',
      rule: 'exfiltration',
      reason: `the session read untrusted content (${input.taint.join(', ')}), and ${input.tool} ${leak}, so a reviewer checks it first`,
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
    // a deny rule matches its pattern anywhere in the text of the value, also in the json text of a list or an
    // object. so "Eve <eve@evil.example>", a trailing dot, or a list in one string cannot get past "*@evil.example".
    // a deny rule that matches too much stops a good call, but a deny rule that matches too little lets a bad call out.
    if (rule.effect === 'deny') return denyForms(value).some((form) => glob(`*${pattern}*`, form));
    // an allow rule must match the whole value, and each item of a list, so one good recipient cannot carry a bad one.
    if (!Array.isArray(value)) return glob(pattern, text(value));
    return value.every((item) => glob(pattern, text(item)));
  });
}

const text = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));

// a url parser, a mail server, or a browser reads "ev%69l.example", fullwidth letters, "evil。example", and
// "evil.example" with a soft hyphen in it as "evil.example". so a deny rule also tests the forms that such a reader
// makes: the nfkc form after percent decoding, without default-ignorable characters and with the other full stops as
// ".", and the href of each url in the text. the json text of a list or an object escapes a backslash and a quote, so
// a deny rule also tests each string of the value on its own. allow rules keep the raw text, because a form that only
// looks like an allowed value must not pass.
function denyForms(value: unknown): string[] {
  const forms = new Set<string>();
  const add = (raw: string) => {
    const normal = percentDecoded(raw).replace(IGNORABLE, '').normalize('NFKC').replace(/[。｡]/g, '.');
    forms.add(raw).add(normal);
    // a url can be the whole value or a part of a command or a message. the parser gives the host that a client uses.
    for (const candidate of [raw.trim(), ...(normal.match(URL_IN_TEXT) ?? [])]) {
      try {
        forms.add(new URL(candidate).href);
      } catch {
        // a text that is not a url keeps its other forms.
      }
    }
  };
  add(text(value));
  if (typeof value === 'object' && value !== null) eachString(value, add);
  return [...forms];
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

// a url can carry data in its query, its fragment, a long path, or a long label of its host (dns lookups leave the pc
// too). a short url such as https://example.com/about carries no more than its choice of page. any query counts,
// because a length limit let a short secret through (24 bytes in base64 fit in 31 characters), and a false match
// costs only one call of the reviewer. the limits on the path and the labels are a filter, not a proof.
const PATH_LIMIT = 100;
const LABEL_LIMIT = 32;
// a url that the session already read carries no new data, for example a link from a mail or a search result. the
// check of each url reads the event log, so a call with many urls goes to the reviewer without the check.
const SEEN_CHECKS = 20;

export function dataUrls(value: unknown): Array<{ url: string; signal: string }> {
  const found: Array<{ url: string; signal: string }> = [];
  eachString(value, (text) => {
    for (const each of text.normalize('NFKC').match(URL_IN_TEXT) ?? []) {
      const signal = urlSignal(each);
      if (signal) found.push({ url: each, signal });
    }
  });
  return found;
}

function urlSignal(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // a text that does not parse as a url cannot reach a host.
    return undefined;
  }
  if (url.search.length > 1 || url.hash.length > 1) return 'it has a query or a fragment';
  if (url.hostname.length + url.pathname.length > PATH_LIMIT) return `its host and path have over ${PATH_LIMIT} characters`;
  if (url.hostname.split('.').some((label) => label.length > LABEL_LIMIT)) return `a label of its host has over ${LABEL_LIMIT} characters`;
  return undefined;
}

// web_search has no url, but it sends its query to a search engine, so its query counts as the query of a url.
function dataLeak(input: PolicyInput): string | undefined {
  const fields = input.input !== null && typeof input.input === 'object' ? (input.input as Record<string, unknown>) : {};
  if (input.tool === 'web_search' && typeof fields.query === 'string' && fields.query.trim()) {
    return `sends a search query (${headOf(fields.query, 200)})`;
  }
  const urls = dataUrls(input.input);
  const seen = input.seen;
  const unseen = urls.length > SEEN_CHECKS || !seen ? urls[0] : urls.find((each) => !seen(each.url));
  return unseen ? `sends a url that can carry data (${headOf(unseen.url, 200)}): ${unseen.signal}` : undefined;
}

// the walk gives each string and number of a list or an object, at any depth. it does not give the keys, but the
// json text of the whole value still holds them.
function eachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string' || typeof value === 'number') visit(String(value));
  else if (Array.isArray(value)) for (const item of value) eachString(item, visit);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) eachString(item, visit);
}

const percentDecoded = (value: string) =>
  value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

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
  // the run stops at its timeout. the call of a reviewer model must stop with it.
  signal: AbortSignal;
}

export interface ReviewResult {
  verdict: 'allow' | 'hold';
  reason: string;
  modelCallId?: number;
}

// reviewer.ts makes the reviewer. without one, a review goes to the owner as an approval, and a reviewer that throws
// also sends the call to the owner.
export type Reviewer = (request: ReviewRequest) => Promise<ReviewResult>;
