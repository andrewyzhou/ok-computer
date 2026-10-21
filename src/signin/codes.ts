import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import type { CodeStore } from './types.js';

// the six-digit codes that go to the owner by text, in signin_codes (028_sessions.sql), with the limits of
// src/signin/limits.ts. the table keeps a salted sha-256 of each code, never the digits. the counts of the limits
// come from signin_events, so they hold over a restart.
export function createCodeStore(deps: { db: Db; clock: Clock }): CodeStore {
  void deps;
  const notBuilt = (): never => {
    throw new Error('not built: the code store');
  };
  return { issue: notBuilt, sent: notBuilt, notSent: notBuilt, verify: notBuilt };
}
