import type { SignInHost, SignInVia } from '../dashboard/signin-types.js';
import type { Db } from '../db/index.js';

// the history of sign-in in signin_events (028_sessions.sql). the session store, the code store and the login route
// write it, and the limits of the code store count it. detail is a short reason in words, never a code, a token or a
// cookie value.

export type SignInEventKind = 'code_sent' | 'code_not_sent' | 'code_refused' | 'signed_in' | 'sign_in_refused' | 'signed_out';

export interface SignInEvent {
  kind: SignInEventKind;
  host: SignInHost;
  via?: SignInVia;
  sessionId?: string;
  codeId?: number;
  detail?: string;
}

export function appendSignInEvent(db: Db, event: SignInEvent, now: Date): number {
  const result = db
    .prepare('INSERT INTO signin_events (kind, host, via, sessionId, codeId, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(event.kind, event.host, event.via ?? null, event.sessionId ?? null, event.codeId ?? null, event.detail?.slice(0, 300) ?? null, now.toISOString());
  return Number(result.lastInsertRowid);
}

// the times of the events of one kind and host since a time, the oldest first. the limits read the count and the
// oldest time, which tells when the window frees a place.
export function signInEventTimes(db: Db, kind: SignInEventKind, host: SignInHost, since: Date): string[] {
  return db
    .prepare('SELECT at FROM signin_events WHERE kind = ? AND host = ? AND at > ? ORDER BY at, id')
    .all(kind, host, since.toISOString())
    .map((row) => String(row.at));
}
