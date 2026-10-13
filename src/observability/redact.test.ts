import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent, listEvents } from '../events/log.js';
import { redact, redactedJson, redactValue, registerSecret } from './redact.js';

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

  // a generated password can start or end with a backslash or a quote. a replacement that cut an escape gave invalid
  // json, and the append-only log then blocked the session for good.
  it('gives valid json for a secret that starts or ends with a backslash or a quote', () => {
    const forms = ['Tr0ub4dor&3pass\\', '\\k9Q2pLx7Zu-only', '"k9Q2pLx7Zv-only', 'pw\\\\x-example-only'];
    for (const secret of forms) registerSecret(secret);
    for (const secret of forms) {
      const once = redactedJson({ content: `token ${secret} here`, list: [secret] });
      expect(JSON.parse(once)).toEqual({ content: 'token [redacted] here', list: ['[redacted]'] });
      const twice = redactedJson({ outer: JSON.stringify({ inner: `x ${secret} y` }) });
      expect(JSON.parse(JSON.parse(twice).outer)).toEqual({ inner: 'x [redacted] y' });
    }
  });

  it('keeps an event with such a secret readable in its session', () => {
    const secret = 'Zz81mQpT4w-example\\';
    registerSecret(secret);
    const db = openDb(':memory:');
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'user_message', payload: { text: `my pw is ${secret}`, channel: 'cli', chatId: 'x' } });
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'system_event', payload: { text: `again ${secret}` } });
    expect(listEvents(db, 'main').map((event) => (event.payload as { text: string }).text)).toEqual(['my pw is [redacted]', 'again [redacted]']);
  });

  it('removes a token after a control character and keeps the json valid', () => {
    for (const id of ['123456', '1234567890']) {
      expect(JSON.parse(redactedJson({ text: `\u0001${id}:${'A'.repeat(32)}` }))).toEqual({ text: '\u0001[redacted]' });
    }
  });

  it('redacts each string of a parsed value, its keys too', () => {
    const secret = 'key-name-example-2026';
    registerSecret(secret);
    expect(redactValue({ [secret]: [`a ${secret}`, 3, null] })).toEqual({ '[redacted]': ['a [redacted]', 3, null] });
  });

  // keys that redact to the same text made one key, and the card, its details and the dashboard lost a value that
  // the approved call still sent.
  it('keeps each value when redacted keys meet each other or a key of the object', () => {
    const one = `111111111:${'A'.repeat(30)}`;
    const two = `222222222:${'B'.repeat(30)}`;
    expect(redactValue({ [one]: 'first', [two]: 'second', to: 'x' })).toEqual({ '[redacted]': 'first', '[redacted] 2': 'second', to: 'x' });
    // the key of the object keeps its name, and the redacted key gets a number.
    expect(redactValue({ properties: { [one]: 'hidden', '[redacted]': 'decoy', '[redacted] 2': 'other' } })).toEqual({
      properties: { '[redacted] 3': 'hidden', '[redacted]': 'decoy', '[redacted] 2': 'other' },
    });
  });

  // an oauth refresh gives new tokens each hour. a list that only grew made each trace write slower for the life of
  // the process: 100 refreshes took one redaction of a tool list from 15 ms to 488 ms.
  // the value before the newest stays too: a request that left with the old token can still be open after a refresh,
  // and its error can quote the authorization header.
  it('keeps the two newest values of a source, and every value without a source', () => {
    registerSecret('fixed-secret-value-2026');
    for (let i = 0; i < 1_000; i++) registerSecret(`access-token-number-${i}`, 'mail:oauth-tokens#access');
    expect(redact('a access-token-number-999 b')).toBe('a [redacted] b');
    expect(redact('a access-token-number-998 b')).toBe('a [redacted] b');
    expect(redact('a access-token-number-997 b')).toBe('a access-token-number-997 b');
    // the same value again does not push the value before it out.
    registerSecret('access-token-number-999', 'mail:oauth-tokens#access');
    expect(redact('a access-token-number-998 b')).toBe('a [redacted] b');
    expect(redact('a fixed-secret-value-2026 b')).toBe('a [redacted] b');
    // a value that two sources hold stays while one of them holds it.
    registerSecret('shared-secret-value-2026', 'one');
    registerSecret('shared-secret-value-2026', 'two');
    registerSecret('other-secret-value-2026', 'one');
    expect(redact('shared-secret-value-2026 other-secret-value-2026')).toBe('[redacted] [redacted]');
  });

  // a token endpoint that quotes its form body in an error showed a google refresh token as 1%2F%2F... in the log.
  it('hides the percent-encoded form of a secret', () => {
    registerSecret('1//refresh/token+value=2026', 'google.test');
    expect(redact('refresh_token=1%2F%2Frefresh%2Ftoken%2Bvalue%3D2026&grant_type=refresh_token')).toBe('refresh_token=[redacted]&grant_type=refresh_token');
  });
});
