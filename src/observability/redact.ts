const REDACTED = '[redacted]';

// these patterns catch keys that were never registered, for example a key that the owner pastes into chat.
const PATTERNS = [/sk-ant-[A-Za-z0-9_-]{10,}/g, /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g];

const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  // a very short value can match normal text, so the redactor ignores it.
  if (value && value.length >= 8) secrets.add(value);
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
