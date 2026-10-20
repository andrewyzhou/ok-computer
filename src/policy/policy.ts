import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Result } from '../config/load.js';
import { headOf } from '../text.js';
import type { AutonomyContext } from './autonomy.js';

// exec runs code that the model wrote in the code sandbox (src/sandbox). the container has no network, so the call
// cannot send data off the pc, but the code can change the scratch files and use the cpu, so a reviewer checks it.
export type Risk = 'read' | 'write' | 'exec' | 'external';
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
  // autonomy_lower can only lower a level of the trust ladder, so each call makes the agent ask more, never less.
  'autonomy_lower',
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
  // the domain of the trust ladder that the call is in, and its level (see autonomy.ts). a call outside the ladder has
  // none, and the policy decides it as before the ladder.
  autonomy?: AutonomyContext;
}

// a sub-agent runs in a session sub:<profile>:<childRunId>. no run reads the result of an approval in that session,
// and the owner did not start the child, so a child never asks the owner. the parent can ask for the same call.
export const SUBAGENT_PREFIX = 'sub:';

export interface Verdict {
  decision: Decision;
  // rule names what decided: a rule id, "taint", "exfiltration", "subagent", "tool", or "risk:<level>".
  rule: string;
  reason: string;
  // the domain and the level that applied to the call. the decision row keeps them for the trace.
  autonomy?: AutonomyContext;
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
      reason: `the session read untrusted content (${sourceNames(input.taint)}), so an external action needs the owner's approval`,
    };
  }
  // in a tainted session an injected instruction can make the model put private data in a link or a search. the
  // reviewer checks such a call, also when a rule allows the tool, because a rule cannot see the data in the call.
  const leak = input.taint.length ? dataLeak(input) : undefined;
  if (leak) {
    return {
      decision: 'review',
      rule: 'exfiltration',
      reason: `the session read untrusted content (${sourceNames(input.taint)}), and ${input.tool} ${leak}, so a reviewer checks it first`,
    };
  }
  if (rule) return { decision: 'allow', rule: rule.id, reason: rule.note ?? `the policy rule ${rule.id} allows ${input.tool}` };
  switch (input.risk) {
    case 'read':
      return { decision: 'allow', rule: 'risk:read', reason: `${input.tool} only reads` };
    case 'write':
      return { decision: 'review', rule: 'risk:write', reason: `${input.tool} changes data, so a reviewer checks it first` };
    case 'exec':
      return { decision: 'review', rule: 'risk:exec', reason: `${input.tool} runs code in the sandbox, so a reviewer checks it first` };
    case 'external':
      return {
        decision: 'approve',
        rule: 'risk:external',
        reason: `${input.tool} sends data off the pc or changes an account, so the owner must approve it`,
      };
  }
}

// a session can read many sources, and a source name can be long. a reason, an approval card and a review name only
// the first sources, so their size has a limit. the taint of each decision keeps the full list for the dashboard.
export const SOURCE_LIMIT = 5;
export const SOURCE_NAME_LIMIT = 200;

export function sourceNames(sources: readonly string[]): string {
  const shown = sources.slice(0, SOURCE_LIMIT).map((each) => headOf(each, SOURCE_NAME_LIMIT));
  const more = sources.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
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
    try {
      forms.add(new URL(raw.trim()).href);
    } catch {
      // a text that is not a url keeps its other forms.
    }
    for (const each of urlsIn(normal)) forms.add(each.url.href);
  };
  add(text(value));
  if (typeof value === 'object' && value !== null) eachString(value, add);
  return [...forms];
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

// a url parser reads more than "https://host/path" as a url: a scheme in any case, no slashes or back slashes after
// the scheme, and a tab or a line break inside the url (the parser drops them). a client that gets a whole string as
// a url also keeps a space or a quote in its path, and so the query after it. so each "http:" starts a candidate that
// goes to the next "http:", and the parser judges it. the part up to the first space, double quote, "<" or ">" is the
// url that a chat app makes a link of. a chat app makes a link through an apostrophe, so an apostrophe does not end a
// link here, and the data after it is judged. a host name with no scheme counts too, with or without a port, a path,
// a query or a fragment, because a chat app makes a link of "evil.example/c?d=1" and of "evil.example", and its
// preview looks up the host. a
// client also opens ws:, wss: and ftp:, and a page opens "//evil.example/c" with its own scheme. an ipv4 address and a
// name with a port ("localhost:8080") count too, because a chat app or a fetch tool adds a scheme to them. a name with
// no dot and no port does not count, because "and/or?" and "src/app.ts" have the same form.
const SCHEME = /(?:https?|wss?|ftp):/gi;
const BARE_URL =
  /(?<![\w.:/@\\-])(?:(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*(?::\d{1,5})?|\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?|[a-z][a-z0-9-]*:\d{1,5})(?:[/?#][^\s"<>]*)?/gi;
const RELATIVE_URL = /(?<![\w:/\\])\/\/[^\s"<>/\\]+[^\s"<>]*/g;
const LINK_END = /[\s"<>]/;
const CANDIDATE_LIMIT = 1024;
// the parser also reads a host that BARE_URL does not see: "evil。example", "evil%2Eexample", "3232235777",
// "0xC0A80101", "[2001:db8::1]", labels that are not ascii ("данные.evil.example", "evil.рф") and labels with an
// underscore. a fetch tool adds a scheme to them, and a chat app can make a link of them. so each word with a dot, a
// path, a query, a fragment, a full stop that is not ascii, or a percent sign is parsed too. it counts when the parser
// gives a host with a dot or an ip address. "and/or?" gives the host "and", so it does not count.
const WORD = /[^\s"<>]+/g;
const PARSED_HOST = /[/?#。｡%]/;
// a word with only a dot counts too, but not a mail address, because the parser reads the name before "@" as a user
// name, and a mail address is no link.
const DOTTED = /^[^@]+\.[^@]+$/;
// a sentence in chinese or japanese has no spaces, so it is one word, and the parser reads its full stop "。" as a dot.
// so the last label of a parsed host must be an ascii top level name, a punycode name ("xn--", the form of "рф" or
// "中国"), or a number of an ip address. a punycode name after a "。" does not count, because that is the end of such a
// sentence. a host that has only an empty label after its dot ("No.#4521") does not count.
const HOST_END = /^(?:[a-z][a-z0-9-]*|\d+)$/;
function parsedHost(hostname: string, word: string): boolean {
  if (hostname.startsWith('[')) return true;
  const labels = hostname.replace(/\.$/, '').split('.');
  const last = labels.at(-1)!;
  return labels.length > 1 && HOST_END.test(last) && !(last.startsWith('xn--') && stopBeforeLast(word) === '。');
}

// the full stop before the last label of the host in a word. the text is in nfkc form, so "｡" is "。" and "．" is ".".
function stopBeforeLast(word: string): string | undefined {
  const host = word.split(/[/?#\\]/)[0]!.replace(/^.*@/, '').replace(/:\d*$/, '').replace(/[.。]$/, '');
  return host.match(/[.。]/g)?.at(-1);
}

interface UrlCandidate {
  text: string;
  url: URL;
  // false when the text holds more than the link, for example the words after a link in a message.
  whole: boolean;
}

function urlsIn(raw: string): UrlCandidate[] {
  const text = raw.normalize('NFKC').replace(/[\t\r\n]/g, '');
  const found: UrlCandidate[] = [];
  const add = (each: string, base: string, whole: boolean) => {
    try {
      found.push({ text: each, url: new URL(base + each), whole });
    } catch {
      // a text that does not parse as a url cannot reach a host.
    }
  };
  // a scheme token in the path of a url does not end the url, because a client fetches all of it. so a candidate
  // goes to the end of the field, and each scheme token inside it starts one more candidate. the length limit keeps
  // the work linear when a field holds many scheme tokens. a candidate that the limit cuts is longer than the path
  // limit, so it has a signal when it is judged whole.
  const first = text.length - text.trimStart().length;
  for (const { index: start } of text.matchAll(SCHEME)) {
    const rest = text.slice(start, start + CANDIDATE_LIMIT).trimEnd();
    const end = rest.search(LINK_END);
    add(end < 0 ? rest : rest.slice(0, end), '', true);
    // a field that holds only the url goes to a client as one url, also with a space or a quote in its path, so it
    // is judged on every signal. a link with words after it in a message is judged only on the query and its kin.
    if (end >= 0) add(rest, '', start === first);
  }
  for (const match of text.matchAll(BARE_URL)) add(match[0], 'https://', true);
  for (const match of text.matchAll(RELATIVE_URL)) add(match[0], 'https:', true);
  // a word that a pattern above found gives the same url again. it is not added again, so that the limit of the seen
  // checks counts each url one time.
  const hrefs = new Set(found.map((each) => each.url.href));
  for (const [word] of text.matchAll(WORD)) {
    if (!PARSED_HOST.test(word) && !DOTTED.test(word)) continue;
    try {
      const url = new URL(`https://${word}`);
      if (parsedHost(url.hostname, word) && !hrefs.has(url.href)) {
        hrefs.add(url.href);
        found.push({ text: word, url, whole: true });
      }
    } catch {
      // a word that does not parse as a url cannot reach a host.
    }
  }
  return found;
}

// the part of a found url that a chat app makes a link of.
export const linkOf = (url: string) => url.split(LINK_END)[0]!;

// a url can carry data in its query, its fragment, a long path, or a long label of its host (dns lookups leave the pc
// too). a short url such as https://example.com/about carries no more than its choice of page. any query counts,
// because a length limit let a short secret through (24 bytes in base64 fit in 31 characters), and a false match
// costs only one call of the reviewer. the path limit is near that size for the same reason: a limit of 100 let about
// 57 bytes through. a long link usually comes from a page or a mail, and such a link passes as read. the limits on the
// path and the labels are a filter, not a proof.
const PATH_LIMIT = 48;
const LABEL_LIMIT = 32;
// a url that the session already read carries no new data, for example a link from a mail or a search result. the
// check of each url reads the event log, so a call with many urls goes to the reviewer without the check.
export const SEEN_CHECKS = 20;

// the finder reads the nfkc form, but the tool gets the raw text. a url can look like a read url only in its nfkc form,
// and then each fullwidth or plain letter in it can carry one bit. so verbatim is false when the raw text does not hold
// the url, and such a url never counts as read.
export interface DataUrl {
  url: string;
  signal: string;
  verbatim: boolean;
}

export function dataUrls(value: unknown): DataUrl[] {
  const found: DataUrl[] = [];
  eachString(value, (text) => {
    for (const each of urlsIn(text)) {
      const signal = urlSignal(each);
      if (signal) found.push({ url: each.text, signal, verbatim: text.includes(each.text) });
    }
  });
  return found;
}

// the policy and the reply guard ask seen only for a url that the text holds verbatim.
export function unseenUrls(urls: DataUrl[], seen?: (url: string) => boolean): DataUrl[] {
  if (urls.length > SEEN_CHECKS || !seen) return urls;
  return urls.filter((each) => !each.verbatim || !seen(each.url));
}

// the words after a link make a long path, so a candidate with more than the link is judged only by the parts that
// carry data in place of a page name: the query, the fragment, and the user name and password (a browser sends them
// after a 401 answer).
function urlSignal({ url, whole }: UrlCandidate): string | undefined {
  if (url.search.length > 1 || url.hash.length > 1) return 'it has a query or a fragment';
  if (url.username || url.password) return 'it has a user name or a password';
  if (!whole) return undefined;
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
  const unseen = unseenUrls(dataUrls(input.input), input.seen)[0];
  return unseen ? `sends a url that can carry data (${headOf(unseen.url, 200)}): ${unseen.signal}` : undefined;
}

// the walk gives each string and number of a list or an object, at any depth, and each key of an object, because a
// tool with a free-form record (for example the headers of a request) sends its keys too.
function eachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string' || typeof value === 'number') visit(String(value));
  else if (Array.isArray(value)) for (const item of value) eachString(item, visit);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      visit(key);
      eachString(item, visit);
    }
  }
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

// a reviewer that fails after its model call names that call, so the trace links the paid call to the decision.
export class ReviewError extends Error {
  constructor(
    message: string,
    readonly modelCallId?: number,
  ) {
    super(message);
  }
}

export const reviewCallOf = (err: unknown) => (err instanceof ReviewError ? err.modelCallId : undefined);

// reviewer.ts makes the reviewer. without one, a review goes to the owner as an approval, and a reviewer that throws
// also sends the call to the owner.
export type Reviewer = (request: ReviewRequest) => Promise<ReviewResult>;
