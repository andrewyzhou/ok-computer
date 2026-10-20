import { clock, time } from '../../format';

// the times of the people views. format.ts keeps the time zone of the owner to itself, so these build on its time
// and clock.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// the year of a time in the owner's time zone. time() gives the local month without the year, so the year comes from
// utc and moves by one when the local month and the utc month are on the two sides of new year.
function localYear(iso: string): number {
  const date = new Date(iso);
  const month = MONTHS.indexOf(time(iso).slice(0, 3));
  const utcMonth = date.getUTCMonth();
  if (month === 11 && utcMonth === 0) return date.getUTCFullYear() - 1;
  if (month === 0 && utcMonth === 11) return date.getUTCFullYear() + 1;
  return date.getUTCFullYear();
}

// the day of a time in the owner's time zone, for example Oct 3, and Jan 2, 2024 for a day of another year than now.
export function day(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const shown = time(iso).split(',')[0]!;
  const year = localYear(iso);
  return year === localYear(new Date(now).toISOString()) ? shown : `${shown}, ${year}`;
}

// the day and the time of a meeting, for example Oct 21, 17:00.
export function dayTime(iso: string | null | undefined, now = Date.now()): string {
  return iso ? `${day(iso, now)}, ${clock(iso)}` : '-';
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
  return day(iso, now);
}
