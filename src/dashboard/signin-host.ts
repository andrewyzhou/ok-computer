import type { Config } from '../config/schema.js';
import type { SignInHost } from './signin-types.js';

// the host of dashboard.publicUrl, which the dashboard serves only with a token. server.ts and the sign-in routes use
// the same answer, so a session and a code of one host never work on the other.
export function remoteHostOf(config: Config, token: string | undefined): string | undefined {
  return token && config.dashboard.publicUrl ? new URL(config.dashboard.publicUrl).hostname : undefined;
}

// signInHost tells whether a request came to the public host or to the loopback address. the host check of server.ts
// already refused every other host.
export function signInHost(requestUrl: string, remoteHost: string | undefined): SignInHost {
  return remoteHost !== undefined && new URL(requestUrl).hostname === remoteHost ? 'remote' : 'local';
}
