import type { DelegationLinkKind, DelegationStatus } from '../dashboard/desk-types.js';
import { badAddress } from '../google/mime.js';
import { zonedToUtc } from '../time.js';

// the rules that the desk store, the agent tools, the follow-up job and the dashboard routes share, so each of them
// checks a delegation the same way.

// the order of the columns of the board.
export const DESK_STATUSES: readonly DelegationStatus[] = ['open', 'waiting', 'blocked', 'done', 'dropped'];
// a delegation in one of these is still in flight. the follow-up job and the brief read only these.
export const ACTIVE_STATUSES: readonly DelegationStatus[] = ['open', 'waiting', 'blocked'];
export const CLOSED_STATUSES: readonly DelegationStatus[] = ['done', 'dropped'];
export const LINK_KINDS: readonly DelegationLinkKind[] = ['run', 'doc', 'thread', 'event'];

export const isActive = (status: DelegationStatus) => ACTIVE_STATUSES.includes(status);
export const isClosed = (status: DelegationStatus) => CLOSED_STATUSES.includes(status);

// the limits of the text fields. the tools and the routes check them in their schemas, and the store cuts nothing.
export const LIMITS = {
  title: 200,
  details: 4_000,
  nextStep: 500,
  name: 200,
  email: 320,
  note: 2_000,
  ref: 200,
  label: 200,
  links: 20,
  q: 200,
} as const;

// the done and dropped columns of the board show this many rows, the newest first.
export const DESK_CLOSED_LIMIT = 50;

// the follow-up job: after a nudge, the next follow-up comes this much later, and after MAX_NUDGES nudges without a
// reply the delegation becomes blocked, so the owner decides what to do.
export const NUDGE_EVERY_MS = 3 * 24 * 60 * 60_000;
export const MAX_NUDGES = 3;

// the session of a follow-up run is desk:followups:<runId>, like the inbox jobs.
export const DESK_PREFIX = 'desk:';

// the key of a person for the filter: the email in lower case, or the name in lower case with single spaces.
export function personKey(waitingOn: { name?: string | null; email?: string | null } | null | undefined): string | null {
  const email = waitingOn?.email?.trim().toLowerCase();
  if (email) return email;
  const name = waitingOn?.name?.trim().replace(/\s+/g, ' ').toLowerCase();
  return name || null;
}

// a waiting-on email must be one plain address, so the follow-up job never takes a header with two mailboxes.
export const validEmail = (email: string) => badAddress([email.trim().toLowerCase()]) === undefined;

// the hash path of a link for the web app, or null when the app has no page for it.
export function hrefOf(link: { kind: DelegationLinkKind; ref: string }): string | null {
  switch (link.kind) {
    case 'run':
      return `runs/${encodeURIComponent(link.ref)}`;
    case 'doc':
      return `docs/${encodeURIComponent(link.ref)}`;
    case 'thread':
    case 'event':
      return null;
  }
}

export type When = { ok: true; iso: string } | { ok: false; error: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// parseWhen reads a due time or a follow-up time. it takes an iso time with an offset, a local "yyyy-mm-dd HH:MM" in
// the time zone of the app, or a bare day: the end of the day (23:59) for a due time, and 09:00 for a follow-up. a day
// that is not on the calendar, for example 2026-02-30, is an error. the check that a time is not in the past is the
// caller's, because the owner may record an old due date.
export function parseWhen(value: string, timeZone: string, kind: 'due' | 'followUp'): When {
  const text = value.trim();
  let date: Date | undefined;
  if (DAY.test(text)) {
    if (!realDay(text)) return { ok: false, error: `${text} is not a day of the calendar` };
    date = zonedToUtc(text, kind === 'due' ? '23:59' : '09:00', timeZone);
  } else if (LOCAL.test(text)) {
    const [, day, hour, minute] = LOCAL.exec(text)!;
    if (!realDay(day!)) return { ok: false, error: `${day} is not a day of the calendar` };
    date = zonedToUtc(day!, `${hour}:${minute}`, timeZone);
  } else if (WITH_OFFSET.test(text) && !Number.isNaN(Date.parse(text))) {
    if (!realDay(text.slice(0, 10))) return { ok: false, error: `${text.slice(0, 10)} is not a day of the calendar` };
    date = new Date(text);
  }
  if (!date || Number.isNaN(date.getTime())) {
    return { ok: false, error: `"${text}" is not a time. give yyyy-mm-dd, "yyyy-mm-dd HH:MM", or an iso time with an offset` };
  }
  return { ok: true, iso: date.toISOString() };
}

function realDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
