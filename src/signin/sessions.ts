import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import type { SessionStore } from './types.js';

// the sign-in sessions of the dashboard in signin_sessions (028_sessions.sql). the cookie value is 32 random bytes,
// and the table keeps only its hmac-sha256 keyed with the dashboard token, so a copy of the database opens no browser
// and a new token signs out every browser. a session lasts sessionLifetimeMs of src/signin/limits.ts.
export function createSessionStore(deps: { db: Db; clock: Clock; secret: string }): SessionStore {
  void deps;
  const notBuilt = (): never => {
    throw new Error('not built: the session store');
  };
  return { create: notBuilt, check: notBuilt, list: notBuilt, end: notBuilt, endAll: notBuilt };
}

// hashCookie gives the hex hmac-sha256 of a cookie value with the secret. the store and its tests use it.
export function hashCookie(secret: string, cookie: string): string {
  void secret;
  void cookie;
  throw new Error('not built: hashCookie');
}
