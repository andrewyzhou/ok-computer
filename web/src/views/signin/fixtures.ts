import type { SignInSessionsPage, SignInSessionView } from '../../../../src/dashboard/signin-types.js';

// the answers of GET /api/sign-in/sessions for the tests and the screenshots of the Settings → Sign-in page. the
// lifetimes are the ones of src/signin/limits.ts.

export const FIXTURE_NOW = '2026-10-21T16:00:00.000Z';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIFETIMES = { short: 12 * HOUR, rememberLocal: 90 * DAY, rememberRemote: 30 * DAY };
const at = (msBefore: number) => new Date(Date.parse(FIXTURE_NOW) - msBefore).toISOString();
const until = (msAfter: number) => new Date(Date.parse(FIXTURE_NOW) + msAfter).toISOString();

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

export const CURRENT: SignInSessionView = {
  id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  host: 'local',
  via: 'text',
  remember: true,
  device: 'Chrome on macOS',
  userAgent: MAC_CHROME,
  createdAt: at(3 * DAY),
  lastUsedAt: at(0),
  expiresAt: until(87 * DAY),
  current: true,
};

export const PHONE: SignInSessionView = {
  id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  host: 'remote',
  via: 'link',
  remember: true,
  device: 'Safari on iPhone',
  userAgent: IPHONE_SAFARI,
  createdAt: at(9 * DAY),
  lastUsedAt: at(2 * HOUR),
  expiresAt: until(21 * DAY),
  current: false,
};

export const LAPTOP: SignInSessionView = {
  id: '99887766554433221100ffeeddccbbaa',
  host: 'remote',
  via: 'token',
  remember: false,
  device: 'Edge on Windows',
  userAgent: WINDOWS_EDGE,
  createdAt: at(5 * HOUR),
  lastUsedAt: at(40 * 60_000),
  expiresAt: until(7 * HOUR),
  current: false,
};

export const UNKNOWN: SignInSessionView = {
  id: '1234567890abcdef1234567890abcdef',
  host: 'local',
  via: 'token',
  remember: false,
  device: 'Unknown device',
  userAgent: null,
  createdAt: at(1 * HOUR),
  lastUsedAt: at(1 * HOUR),
  expiresAt: until(11 * HOUR),
  current: false,
};

// every state that the page must show.
export const FULL: SignInSessionsPage = {
  sessions: [CURRENT, PHONE, LAPTOP, UNKNOWN],
  textCode: 'ready',
  publicUrl: 'https://okc-pc.example.ts.net',
  lifetimes: LIFETIMES,
};

// only this browser is signed in, with the token, on loopback, and telegram is not set up.
export const FIRST_RUN: SignInSessionsPage = {
  sessions: [{ ...CURRENT, via: 'token', remember: false, createdAt: at(60_000), expiresAt: until(12 * HOUR - 60_000) }],
  textCode: 'no-telegram',
  publicUrl: null,
  lifetimes: LIFETIMES,
};

// the token came in the query, so no session is current.
export const NO_CURRENT: SignInSessionsPage = { ...FULL, sessions: [PHONE, LAPTOP] };

export const EMPTY: SignInSessionsPage = { ...FULL, sessions: [] };
