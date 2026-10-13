const REDACTED = '[redacted]';

// these patterns catch keys that were never registered, for example a key that the owner pastes into chat. the
// token pattern does not use a word boundary at its start. in json text, a newline before a token becomes "\n", and
// the letter n then hides the boundary.
const PATTERNS = [/sk-ant-[A-Za-z0-9_-]{10,}/g, /(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}\b/g];

const secrets = new Set<string>();
// a model request holds an event that holds a tool result that holds json. four levels cover this.
const ESCAPE_LEVELS = 4;

export function registerSecret(value: string | undefined): void {
  // a very short value can match normal text, so the redactor ignores it.
  if (!value || value.length < 8) return;
  // most stored payloads are json text. a quote or a backslash in a secret is escaped there, so the escaped form is
  // a secret too. json text can contain json text, for example a tool result that is json inside an event. each level
  // escapes the secret again, so each level adds a form.
  let form = value;
  for (let level = 0; level < ESCAPE_LEVELS; level++) {
    secrets.add(form);
    const escaped = JSON.stringify(form).slice(1, -1);
    if (escaped === form) return;
    form = escaped;
  }
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

export function redactedJson(value: unknown): string {
  return redact(JSON.stringify(value));
}
