import { clock, time } from '../../format';

// the times of the people views. format.ts keeps the time zone of the owner to itself, so these build on its time
// and clock.

// the day of a time in the owner's time zone, for example Oct 3.
export function day(iso: string | null | undefined): string {
  return iso ? time(iso).split(',')[0]! : '-';
}

// the day and the time of a meeting, for example Oct 21, 17:00.
export function dayTime(iso: string | null | undefined): string {
  return iso ? `${day(iso)}, ${clock(iso)}` : '-';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// a time near now in words, for example 3 days ago or in 2 h. a time more than 30 days away shows its day.
export function ago(iso: string, now = Date.now()): string {
  const diff = now - Date.parse(iso);
  const past = diff >= 0;
  const size = Math.abs(diff);
  const words = (text: string) => (past ? `${text} ago` : `in ${text}`);
  if (size < MINUTE) return past ? 'just now' : 'in a minute';
  if (size < HOUR) return words(`${Math.floor(size / MINUTE)} min`);
  if (size < DAY) return words(`${Math.floor(size / HOUR)} h`);
  const days = Math.floor(size / DAY);
  if (days === 1) return past ? 'yesterday' : 'tomorrow';
  if (days <= 30) return words(`${days} days`);
  return day(iso);
}
