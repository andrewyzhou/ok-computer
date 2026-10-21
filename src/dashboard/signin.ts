import type { Hono } from 'hono';
import type { SignIn } from '../signin/types.js';
import type { DashboardDeps } from './server.js';

// track s1 owns this module. it mounts the routes of the Settings → Sign-in page, and src/dashboard/signin-types.ts
// gives their shapes. server.ts calls it after the sign-in check, so each route is behind the dashboard auth, and a
// write without a json body already got 415 there. the routes:
// - GET /api/sign-in/sessions gives a SignInSessionsPage.
// - POST /api/sign-in/sessions/:id/end takes {} and ends one session. it gives an EndSessionsResult.
// - POST /api/sign-in/sessions/end-all takes an EndAllRequest and gives an EndSessionsResult.
// the current session is the one of the okc_session cookie (SESSION_COOKIE of src/signin/cookie.ts). a request with the
// token in a header or the query has no current session. when the session of this browser ends, the answer also
// clears its cookie. without a dashboard token there are no sessions: each route answers 404 with a json error.
export function mountSignIn(server: Hono, deps: DashboardDeps, signIn: SignIn | undefined): void {
  void deps;
  void signIn;
  server.get('/api/sign-in/sessions', () => {
    throw new Error('not built: the sign-in settings routes');
  });
}
