// the shapes of the sign-in api (track s1 of docs/CONNECT-PLAN.md). the login page and the web pages import this file,
// so it holds types only and imports nothing. every time is an iso string in utc.

// local is the loopback address of the pc, remote is the host of dashboard.publicUrl.
export type SignInHost = 'local' | 'remote';
// how a session began: the dashboard token, the link that /dashboard sends, or a six-digit code by text.
export type SignInVia = 'token' | 'link' | 'text';
export type SessionEndReason = 'signed_out' | 'signed_out_all';

// ready: the app can send a code to the owner's telegram chat. no-telegram: TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID
// is not set, so the page offers only the token.
export type TextCodeState = 'ready' | 'no-telegram';

// the body of POST /api/login. code is the link code of /dashboard, textCode the six digits that came by text, and
// token the dashboard token. remember asks for the long session (see SESSION_LIFETIME_MS in src/signin/limits.ts).
export type LoginRequest =
  | { token: string; remember?: boolean }
  | { code: string; remember?: boolean }
  | { textCode: string; remember?: boolean };

export interface LoginResponse {
  ok: true;
  // when the new session ends, so the page can say so.
  expiresAt: string;
}

// the answer of POST /api/login/code, which takes an empty json object. the code goes to telegram, never into this
// answer.
export interface TextCodeSent {
  sent: true;
  // when the code stops working.
  expiresAt: string;
  // the seconds until the page may ask for another code.
  retryAfterSeconds: number;
}

// the error body of POST /api/login/code and of a refused POST /api/login. retryAfterSeconds is set with a 429.
export interface SignInError {
  error: string;
  retryAfterSeconds?: number;
}

// one row of the Settings → Sign-in page.
export interface SignInSessionView {
  id: string;
  host: SignInHost;
  via: SignInVia;
  remember: boolean;
  // a short name of the browser and the system, for example "Chrome on macOS", or "Unknown device".
  device: string;
  // the user agent as the browser sent it, cut to 300 characters, or null.
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  // true for the session of the browser that asked.
  current: boolean;
}

// GET /api/sign-in/sessions. sessions holds the live sessions only, the current one first, then the newest last use
// first.
export interface SignInSessionsPage {
  sessions: SignInSessionView[];
  textCode: TextCodeState;
  // true when dashboard.publicUrl is served, so a remote session can exist.
  publicUrl: string | null;
  // the lifetimes in milliseconds, for the words of the page.
  lifetimes: { short: number; rememberLocal: number; rememberRemote: number };
}

// the body of POST /api/sign-in/sessions/end-all.
export interface EndAllRequest {
  // true signs out every other session and keeps this one.
  keepCurrent: boolean;
}

// the answer of POST /api/sign-in/sessions/:id/end and of POST /api/sign-in/sessions/end-all.
export interface EndSessionsResult {
  ended: number;
  // true when the session of this browser ended. the page then goes to /login.
  signedOutHere: boolean;
}
