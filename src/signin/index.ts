import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import { createCodeStore } from './codes.js';
import { createSessionStore } from './sessions.js';
import type { CodeCourier, SignIn } from './types.js';

// createSignIn joins the parts of sign-in for one dashboard. it exists only with a dashboard token: without one the
// dashboard is open on loopback and has no sessions. the token keys the hashes of the cookies, so a new token ends
// every session.
export function createSignIn(deps: { db: Db; clock: Clock; token: string; courier?: CodeCourier }): SignIn {
  const { db, clock, token, courier } = deps;
  return {
    sessions: createSessionStore({ db, clock, secret: token }),
    codes: createCodeStore({ db, clock }),
    textCode: () => (courier?.available() ? 'ready' : 'no-telegram'),
    ...(courier ? { courier } : {}),
  };
}
