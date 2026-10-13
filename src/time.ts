export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

// the owner reads times in their own time zone. the database keeps utc iso strings.
export function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(date);
}

function localParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

// a day is the calendar date in the owner's time zone, in the form YYYY-MM-DD.
export function localDay(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// the time of day in the owner's time zone, in the form HH:MM.
export function localTime(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// the offset can change at the converted time because of daylight saving time, so the function checks it two times.
export function zonedToUtc(day: string, time: string, timeZone: string): Date {
  const naive = Date.parse(`${day}T${time}:00Z`);
  const offset = (at: number) => {
    const p = localParts(new Date(at), timeZone);
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - at;
  };
  const first = naive - offset(naive);
  return new Date(naive - offset(first));
}
