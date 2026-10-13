import { describe, expect, it } from 'vitest';
import { buttonSigner, MAX_BUTTON_DATA } from './telegram-buttons.js';

describe('buttonSigner', () => {
  const signer = buttonSigner('123:token-a');

  it('gives back the data of a button that it signed, inside the 64 byte limit', () => {
    const data = 'approval:12345:always-yes:'.padEnd(MAX_BUTTON_DATA, 'z');
    const signed = signer.sign(data);
    expect(Buffer.byteLength(signed)).toBe(64);
    expect(signer.check(signed)).toBe(data);
    expect(signer.check(signer.sign('x.y'))).toBe('x.y');
  });

  it('refuses data without a mark, with a wrong mark, or with the mark of other data', () => {
    expect(signer.check('approval:1:approve')).toBeUndefined();
    expect(signer.check('approval:1:approve.')).toBeUndefined();
    expect(signer.check('approval:1:approve.AAAAAAAAAAAAAAAA')).toBeUndefined();
    const other = signer.sign('approval:2:approve');
    expect(signer.check(`approval:1:approve${other.slice(other.lastIndexOf('.'))}`)).toBeUndefined();
    const real = signer.sign('approval:1:approve');
    expect(signer.check(`${real}x`)).toBeUndefined();
  });

  it('throws for data longer than 47 bytes, because the button would go over the limit', () => {
    expect(() => signer.sign('a'.repeat(MAX_BUTTON_DATA + 1))).toThrow(/longer than 47 bytes/);
    expect(() => signer.sign('é'.repeat(24))).toThrow();
  });

  it('gives a different mark for a different bot token', () => {
    const signed = signer.sign('approval:1:approve');
    expect(buttonSigner('123:token-b').sign('approval:1:approve')).not.toBe(signed);
    expect(buttonSigner('123:token-b').check(signed)).toBeUndefined();
  });
});
