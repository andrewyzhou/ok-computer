import type { SignInHost } from '../dashboard/signin-types.js';

// the numbers of sign-in (track s1 of docs/CONNECT-PLAN.md). the stores, the routes, the login page and the tests read
// them here, so a change reaches each of them.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// a code by text lasts 10 minutes and allows 5 wrong tries. a sixth try fails even with the right digits.
export const CODE_TTL_MS = 10 * MINUTE;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_DIGITS = 6;

// the sends of one host: one a minute, and at most 5 an hour. each code goes to the owner's own chat, so a stranger
// who presses the button only sends the owner messages, and these limits keep that to a few.
export const SEND_GAP_MS = MINUTE;
export const SENDS_PER_HOUR = 5;

// wrong codes of one host in the last hour, over every code. at 20 the host can send no code and try no code until
// the oldest of them is an hour old. with 5 sends of 5 tries an hour, a guess has about 1 chance in 40,000 an hour.
export const FAILS_PER_HOUR = 20;
export const RATE_WINDOW_MS = HOUR;

// a session without remember me lasts 12 hours and its cookie ends with the browser. remember me gives 90 days on the
// loopback address and 30 days on the public url, with a cookie of the same max-age.
export const SHORT_SESSION_MS = 12 * HOUR;
export const REMEMBER_MS: Record<SignInHost, number> = { local: 90 * DAY, remote: 30 * DAY };

export function sessionLifetimeMs(host: SignInHost, remember: boolean): number {
  return remember ? REMEMBER_MS[host] : SHORT_SESSION_MS;
}

// lastUsedAt moves at most once in this time, so each api request does not write the database.
export const TOUCH_GAP_MS = MINUTE;

// a user agent longer than this is cut before it is stored.
export const USER_AGENT_MAX = 300;
