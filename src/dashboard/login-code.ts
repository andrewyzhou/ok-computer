import type { Hono } from 'hono';
import type { SignIn } from '../signin/types.js';
import type { DashboardDeps } from './server.js';

// track s1 owns this module. it mounts POST /api/login/code, which asks for a six-digit code by text. the route comes
// before a sign-in, so the auth middleware of server.ts lets it through like /api/login, and the host check and the
// json check still apply. it takes {} and gives a TextCodeSent, or a SignInError: 404 without a dashboard token, 409
// when telegram is not set up, 429 with retryAfterSeconds and a retry-after header while a limit holds, and 502 when
// telegram did not take the message. the code goes only to telegram, never into the answer or the log.
export function mountLoginCode(server: Hono, deps: DashboardDeps, signIn: SignIn | undefined): void {
  void deps;
  void signIn;
  server.post('/api/login/code', () => {
    throw new Error('not built: POST /api/login/code');
  });
}
