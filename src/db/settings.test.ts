import { describe, expect, it } from 'vitest';
import { openDb } from './index.js';
import { getSetting, setSetting } from './settings.js';

describe('settings', () => {
  it('stores json values and replaces them by key', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, 'k')).toBeUndefined();
    setSetting(db, 'k', { a: 1 }, new Date());
    setSetting(db, 'k', 'text', new Date());
    expect(getSetting<string>(db, 'k')).toBe('text');
  });
});
