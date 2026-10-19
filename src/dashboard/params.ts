// the query rules of the phase 5 endpoints (docs/PHASE5-API.md section 1). a limit is clamped to the range of its
// endpoint, and a value that is not a number gives the default.

export function limitOf(value: string | undefined, max: number, fallback: number): number {
  const parsed = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

// a row id in a query, for example before. a value that is not a positive whole number gives undefined, and the
// caller answers 400.
export function idOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d{0,15}$/.test(value)) return undefined;
  return Number(value);
}

// a day of the calendar as yyyy-mm-dd. a value of that shape that names no date, for example 2026-13-45, is not a day.
export function isDay(value: string | undefined): value is string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
