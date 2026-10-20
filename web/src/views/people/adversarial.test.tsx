// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setTimeZone } from '../../format';
import { initialsOf, PersonChip } from './PersonChip';
import { ago, day, dayTime } from './when';

// the person chip and the times of the people views with odd names, odd times and time zones far from utc.

afterEach(() => {
  cleanup();
  setTimeZone('UTC');
});

describe('initialsOf with odd text', () => {
  it.each([
    ['😀 🎉', '?'],
    ['𝒜lice 𝒵ed', '𝒜𝒵'],
    ['"Doe, Jane"', 'DJ'],
    ['jane+tag@acme.com', 'J'],
    ['ılker', 'I'],
    ['‮evil', 'E'],
  ])('%j gives %j', (text, initials) => {
    expect(initialsOf(text)).toBe(initials);
  });
});

describe('the times of the people views', () => {
  it('shows the day of the owner zone, not of utc, near midnight', () => {
    const now = Date.parse('2026-10-18T16:00:00.000Z');
    setTimeZone('America/Los_Angeles');
    expect(day('2026-10-18T06:59:00.000Z', now)).toBe('Oct 17');
    expect(dayTime('2026-10-18T06:59:00.000Z', now)).toBe('Oct 17, 23:59');
    setTimeZone('Asia/Tokyo');
    expect(day('2026-10-17T15:00:00.000Z', now)).toBe('Oct 18');
  });

  it('adds the year to a day of another year than now, in the owner zone on both sides of new year', () => {
    const now = Date.parse('2026-10-18T16:00:00.000Z');
    expect(day('2024-01-02T08:00:00.000Z', now)).toBe('Jan 2, 2024');
    expect(dayTime('2027-03-01T09:30:00.000Z', now)).toBe('Mar 1, 2027, 09:30');
    expect(ago('2025-06-01T12:00:00.000Z', now)).toBe('Jun 1, 2025');
    // 2027-01-01 04:00 utc is still new year's eve of 2026 in los angeles, so it is this year there.
    setTimeZone('America/Los_Angeles');
    expect(day('2027-01-01T04:00:00.000Z', now)).toBe('Dec 31');
    // 2026-12-31 20:00 utc is already 2027 in tokyo.
    setTimeZone('Asia/Tokyo');
    expect(day('2026-12-31T20:00:00.000Z', now)).toBe('Jan 1, 2027');
  });

  it('shows a dash for a missing time', () => {
    expect(day(null)).toBe('-');
    expect(dayTime(undefined)).toBe('-');
  });

  it('says just now and in a minute on both sides of now', () => {
    const now = Date.parse('2026-10-18T16:00:00.000Z');
    expect(ago('2026-10-18T16:00:00.000Z', now)).toBe('just now');
    expect(ago('2026-10-18T16:00:30.000Z', now)).toBe('in a minute');
    expect(ago('2026-10-18T17:00:00.000Z', now)).toBe('in 1 h');
    expect(ago('2026-10-19T16:00:00.000Z', now)).toBe('tomorrow');
  });
});

describe('the person chip with a hostile name', () => {
  it('shows a name with markup as text', () => {
    render(<PersonChip email="evil@acme.com" name={'<img src=x onerror=alert(1)>'} personId={7} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('#/people/7');
    expect(link.querySelector('img')).toBeNull();
    expect(link.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows plain text for an empty address', () => {
    render(<PersonChip email="   " />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
