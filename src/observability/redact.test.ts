import { describe, expect, it } from 'vitest';
import { redact, redactedJson, registerSecret } from './redact.js';

// the token has the shape of a bot token. it is not a real token.
const TOKEN = `1234567890:${'A'.repeat(35)}`;

describe('redact', () => {
  it('removes a token in json text also after a newline or a tab', () => {
    for (const text of [`token ${TOKEN}`, `line\n${TOKEN}`, `tab\t${TOKEN}`, `quote"${TOKEN}`]) {
      expect(redact(text)).not.toContain('AAAA');
      expect(redactedJson({ text })).not.toContain('AAAA');
      expect(redactedJson({ nested: JSON.stringify({ text }) })).not.toContain('AAAA');
    }
  });

  it('removes a registered secret with a quote or a backslash from json text', () => {
    const secret = 'pa"ss\\word-2026';
    registerSecret(secret);
    expect(redact(`the password is ${secret}`)).toBe('the password is [redacted]');
    expect(redactedJson({ text: `the password is ${secret}` })).toBe('{"text":"the password is [redacted]"}');
  });

  it('removes a secret with a quote from json text inside json text, as in a tool result that is json', () => {
    const secret = 'qu"ote\\slash-2026';
    registerSecret(secret);
    const result = JSON.stringify({ apiKey: secret, list: [`x ${secret}`] });
    expect(redactedJson({ type: 'tool_result', content: result })).not.toContain('slash-2026');
    expect(redactedJson({ outer: JSON.stringify({ content: result }) })).not.toContain('slash-2026');
  });

  it('gives the same text for a string and for the same string inside json', () => {
    const text = `a result\n${TOKEN}\nmore`;
    expect(JSON.parse(redactedJson({ content: text })).content).toBe(redact(text));
  });
});
