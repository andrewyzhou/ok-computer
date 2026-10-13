const REDACTED = '[redacted]';

// these patterns catch keys that were never registered, for example a key that the owner pastes into chat. the
// token pattern does not use a word boundary at its start. in json text, a newline before a token becomes "\n", and
// the letter n then hides the boundary.
const PATTERNS = [/sk-ant-[A-Za-z0-9_-]{10,}/g, /(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}\b/g];

// the longest form comes first. a raw form is part of its own escaped form, for example "pw\" in "pw\\". when the
// raw form is replaced first, it takes one half of an escape, and the json text that remains is not valid.
let secrets: string[] = [];
// a model request holds an event that holds a tool result that holds json. four levels cover this.
const ESCAPE_LEVELS = 4;
// the forms of each value. a value without a source stays for the life of the process. a value with a source
// replaces the last value of that source: an oauth refresh gives new tokens each hour, and redact makes one pass for
// each form, so a list that only grows made each trace write slower (100 refreshes: 15 ms to 488 ms for one list).
const fixed = new Set<string>();
const bySource = new Map<string, string[]>();

// source names the place that holds the value, for example the reference of a credential. only the newest value of a
// source stays registered. an old token is not sent again, and it was never in a trace row, because a header is not
// recorded.
export function registerSecret(value: string | undefined, source?: string): void {
  // a very short value can match normal text, so the redactor ignores it.
  if (!value || value.length < 8) return;
  // a string inside json text has its quotes and backslashes escaped, so the escaped form is a secret too. json text
  // can contain json text, for example a tool result that is json inside an event. each level escapes the secret
  // again, so each level adds a form.
  const forms: string[] = [];
  let form = value;
  for (let level = 0; level < ESCAPE_LEVELS; level++) {
    forms.push(form);
    const escaped = JSON.stringify(form).slice(1, -1);
    if (escaped === form) break;
    form = escaped;
  }
  if (source === undefined) forms.forEach((each) => fixed.add(each));
  else bySource.set(source, forms);
  secrets = [...new Set([...fixed, ...[...bySource.values()].flat()])].sort((a, b) => b.length - a.length);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

// the redaction works on each string before the json text exists, so a replacement can never cut an escape and make
// the json text invalid. an invalid payload in the append-only event log blocks its session for good. the escaped
// forms still catch a secret in a string that is json text itself.
// json has no text for undefined, and a database column cannot take undefined. a model can send a tool call without
// its arguments, so undefined becomes the text null.
export function redactedJson(value: unknown): string {
  return JSON.stringify(value, redactLeaf) ?? 'null';
}

// redactValue gives a copy with each string redacted, for a caller that needs the value and not its text.
export function redactValue<T>(value: T): T {
  return JSON.parse(redactedJson(value)) as T;
}

function redactLeaf(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [redact(key), each]));
  }
  return value;
}
