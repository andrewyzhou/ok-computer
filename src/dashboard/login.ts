import { randomBytes } from 'node:crypto';
import type { Clock } from '../time.js';

// a code from /dashboard works one time, for a short time. it goes through telegram, so it must not stay valid.
const CODE_MS = 5 * 60_000;

export interface LoginCodes {
  // issue gives undefined until the dashboard of this process listens. no other server knows the code, so a link with
  // it would only fail.
  issue(): string | undefined;
  // spend gives true one time for a code that did not expire.
  spend(code: string): boolean;
  // startDashboard calls this when its server listens.
  listening(): void;
}

// the codes live in memory, in the process that runs the dashboard. a restart makes every open code invalid.
export function createLoginCodes(clock: Clock): LoginCodes {
  const codes = new Map<string, number>();
  let live = false;
  return {
    issue() {
      if (!live) return undefined;
      const now = clock().getTime();
      for (const [code, expires] of codes) if (expires <= now) codes.delete(code);
      const code = randomBytes(16).toString('base64url');
      codes.set(code, now + CODE_MS);
      return code;
    },
    spend(code) {
      const expires = codes.get(code);
      codes.delete(code);
      return expires !== undefined && clock().getTime() < expires;
    },
    listening() {
      live = true;
    },
  };
}

// a sign-in cookie is a random id that lives in memory, never a value derived from the token. a browser sends a cookie
// to every port and every path of its host. so a cookie of 127.0.0.1 reaches each local server that the owner opens,
// and a cookie of the tailnet name reaches each other service that is shared on that name. such a server can replay
// the id, but only until it expires or the app restarts.
// a sign-in on the pc lasts 12 hours. a sign-in on the tailnet name lasts 30 days, because the phone signs in with a
// code from /dashboard, which takes more steps.
export const LOCAL_SESSION_MS = 12 * 60 * 60_000;
export const REMOTE_SESSION_MS = 30 * 24 * 60 * 60_000;

export interface Sessions {
  issue(): string;
  valid(id: string | undefined): boolean;
}

export function createSessions(clock: Clock, lifetimeMs: number): Sessions {
  const sessions = new Map<string, number>();
  return {
    issue() {
      const now = clock().getTime();
      for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
      const id = randomBytes(32).toString('hex');
      sessions.set(id, now + lifetimeMs);
      return id;
    },
    valid(id) {
      const expires = id === undefined ? undefined : sessions.get(id);
      return expires !== undefined && clock().getTime() < expires;
    },
  };
}
