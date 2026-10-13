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
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)} min ${Math.round((value % 60_000) / 1000)} s`;
}

export function percent(value: number | null): string {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
}

export function shortDay(day: string): string {
  return day.slice(5);
}
