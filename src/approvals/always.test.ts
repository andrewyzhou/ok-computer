import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addRule, parseAlwaysButton } from './always.js';

const rule = { tool: 'notes__add_note', effect: 'allow' as const, note: 'from approval #1' };
const fresh = () => join(mkdtempSync(join(tmpdir(), 'okc-always-')), 'okc.policy.json');

describe('always allow', () => {
  it('creates the file, keeps the rules of the owner, and gives the new list with ids', () => {
    const path = fresh();
    const first = addRule(path, rule);
    expect(first.ok && first.value.at(-1)).toEqual({ ...rule, id: `${path}#1` });
    writeFileSync(path, JSON.stringify({ rules: [{ tool: 'x', effect: 'deny', note: 'mine' }, rule] }));
    const second = addRule(path, { ...rule, tool: 'other' });
    expect(second.ok && second.value.filter((each) => each.id.startsWith(path)).map((each) => each.tool)).toEqual(['x', 'notes__add_note', 'other']);
  });

  it('changes nothing when the file is broken or the result would be invalid', () => {
    const broken = fresh();
    writeFileSync(broken, '{ not json');
    expect(addRule(broken, rule)).toMatchObject({ ok: false, error: expect.stringContaining('is not valid json') });
    expect(readFileSync(broken, 'utf8')).toBe('{ not json');

    // the owner added a key that the loader refuses. the old text comes back.
    const strict = fresh();
    writeFileSync(strict, '{"rules": [], "extra": 1}');
    expect(addRule(strict, rule).ok).toBe(false);
    expect(readFileSync(strict, 'utf8')).toBe('{"rules": [], "extra": 1}');

    const missing = fresh();
    expect(addRule(missing, { ...rule, tool: '' }).ok).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it('reads only its own buttons', () => {
    expect(parseAlwaysButton('approval:3:always')).toEqual({ id: 3, confirmed: false });
    expect(parseAlwaysButton('approval:3:always-yes')).toEqual({ id: 3, confirmed: true });
    expect(parseAlwaysButton('approval:3:approve')).toBeUndefined();
    expect(parseAlwaysButton('approval:3:always-yes-please')).toBeUndefined();
  });
});
