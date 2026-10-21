import type { SessionEndReason, SignInHost, SignInVia, TextCodeState } from '../dashboard/signin-types.js';

// the interfaces of the sign-in module (track s1 of docs/CONNECT-PLAN.md). src/signin/index.ts joins the parts, and
// the dashboard uses them only through these interfaces. this file holds types only.

// one row of signin_sessions (028_sessions.sql), without its hash.
export interface SessionRecord {
  id: string;
  host: SignInHost;
  via: SignInVia;
  remember: boolean;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: SessionEndReason | null;
}

export interface NewSession {
  host: SignInHost;
  via: SignInVia;
  remember: boolean;
  // the user-agent header of the login request, if any. the store cuts it to USER_AGENT_MAX.
  userAgent?: string;
}

export interface SessionStore {
  // create makes a new session and gives the cookie value, 32 random bytes as 64 hex characters. only its hmac goes
  // into the database, and it writes a signed_in event.
  create(input: NewSession): { cookie: string; session: SessionRecord };
  // check gives the live session of a cookie value on its own host, or undefined: for no cookie, an unknown value, a
  // session of the other host, an ended one or an expired one. it moves lastUsedAt when the last move is older than
  // TOUCH_GAP_MS. it compares hashes, never the raw value, so a lookup does not leak the time of a compare.
  check(cookie: string | undefined, host: SignInHost): SessionRecord | undefined;
  // list gives the live sessions, the newest last use first.
  list(): SessionRecord[];
  // end ends one live session and writes a signed_out event. false when the id is unknown or the session already
  // ended or expired.
  end(id: string, reason: SessionEndReason): boolean;
  // endAll ends every live session but the one of exceptId, and gives how many ended.
  endAll(reason: SessionEndReason, exceptId?: string): number;
}

export type IssueResult =
  | { ok: true; code: string; codeId: number; expiresAt: string }
  // rate_limited: the gap or the hourly limit of the sends, or too many wrong codes. retryAfterMs is the wait until
  // a send works again, at least 1000.
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number };

export type VerifyResult =
  | { ok: true; codeId: number }
  // no_code: no open code of this host. wrong: the digits do not match, and the try counts. expired: the open code is
  // older than CODE_TTL_MS. locked: the code had CODE_MAX_ATTEMPTS wrong tries, or the host had FAILS_PER_HOUR. a
  // code that was used is no longer open, so a second use gives no_code.
  | { ok: false; reason: 'no_code' | 'wrong' | 'expired' | 'locked' };

export interface CodeStore {
  // issue makes a new six-digit code for a host, and makes each older open code of that host dead. it does not send
  // it. the caller sends it and then calls sent or notSent, which write the event that the send limits count.
  issue(host: SignInHost): IssueResult;
  sent(codeId: number, host: SignInHost): void;
  notSent(codeId: number, host: SignInHost, detail: string): void;
  // verify checks the digits against the newest open code of the host in constant time, and spends it on a match.
  // a wrong try writes a code_refused event.
  verify(code: string, host: SignInHost): VerifyResult;
}

// the way a code reaches the owner. the app gives the telegram chat of the owner, and a test gives a fake.
export interface CodeCourier {
  // true when the telegram channel runs and the owner's chat id is known.
  available(): boolean;
  // send gives false when the channel refused the message. the text is never logged.
  send(text: string): Promise<boolean>;
}

// what the server-rendered login page shows (src/signin/page.ts).
export interface LoginPageView {
  host: SignInHost;
  textCode: TextCodeState;
  // the lifetime of a remembered session on this host, in days, for the words next to the box.
  rememberDays: number;
}

// the parts that the dashboard uses. createSignIn of src/signin/index.ts makes them.
export interface SignIn {
  sessions: SessionStore;
  codes: CodeStore;
  textCode(): TextCodeState;
  courier?: CodeCourier;
}
