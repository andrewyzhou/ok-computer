// the server gives all times in utc. the pages show them in the owner's time zone, which comes from /api/meta.
let timeZone = 'UTC';

export function setTimeZone(value: string): void {
  timeZone = value;
}

export function time(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(iso),
  );
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function tokens(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function duration(from: string, to: string | null): string {
  if (!to) return 'running';
  return ms(Date.parse(to) - Date.parse(from));
}

export function ms(value: number): string {
  if (value < 1000) return `${value} ms`;
  // the value is rounded once before it is split, so a value just under a minute never shows 60 s.
  if (value < 59_950) return `${(value / 1000).toFixed(1)} s`;
  const total = Math.round(value / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

// a count with its noun: 1 blob, 2 blobs. a noun with an irregular plural passes it as the third value.
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function percent(value: number | null): string {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
}

export function shortDay(day: string): string {
  return day.slice(5);
}

// a day is yyyy-mm-dd in the time zone of the app, so it is shown as it is, with no change of time zone.
export function longDay(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${day}T00:00:00Z`));
}
