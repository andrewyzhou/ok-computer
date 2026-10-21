import type { CookieOptions } from 'hono/utils/cookie';
import type { SignInHost } from '../dashboard/signin-types.js';

// the name of the sign-in cookie. the settings routes read it to tell the current session.
export const SESSION_COOKIE = 'okc_session';

// sessionCookie gives the options of the sign-in cookie: HttpOnly, SameSite=Strict and Path=/ always, Secure when the
// browser uses https, and a Max-Age of the remembered lifetime only with remember. without remember the cookie ends
// with the browser, and the server ends the session after SHORT_SESSION_MS.
export function sessionCookie(host: SignInHost, remember: boolean, https: boolean): CookieOptions {
  void host;
  void remember;
  void https;
  throw new Error('not built: sessionCookie');
}
