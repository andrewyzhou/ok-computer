import { describe, expect, it } from 'vitest';
import { isoWeek } from './consolidate.js';

describe('isoWeek', () => {
  it('follows the iso rules at the turn of the year', () => {
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
    expect(isoWeek('2026-10-12')).toBe('2026-W42');
    expect(isoWeek('2026-10-18')).toBe('2026-W42');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    expect(isoWeek('2027-01-04')).toBe('2027-W01');
    expect(isoWeek('2025-12-29')).toBe('2026-W01');
  });
});
