import { pathToFileURL } from 'node:url';
import type { GoogleTokenImportResponse } from '../dashboard/types.js';
import type { SecretStore } from '../integrations/secrets.js';

// npm run google:push -- <alias> --to <https url of the server dashboard>
// the owner signs in to google on a desktop, then this command sends the refresh token of one account to the server
// through POST /api/google/accounts/:alias/token. the server has no browser, so it cannot do the loopback sign-in.

export interface PushOptions {
  alias: string;
  // the https address of the server dashboard, for example its tailscale serve url.
  to: string;
}

export interface PushDeps {
  // the store of the desktop. it holds google.<alias> after a sign-in on the desktop.
  secrets: SecretStore;
  // the clientId of the google block of the desktop config.
  clientId: string;
  // the DASHBOARD_TOKEN of the server, from OKC_REMOTE_TOKEN. never the token of the desktop.
  token: string;
  fetch?: typeof fetch;
}

// TODO(m7 push): build it. the work package gives the arguments and the errors.
export function parsePushArgs(_argv: string[]): PushOptions | { error: string } {
  throw new Error('not built: parsePushArgs');
}

// TODO(m7 push): build it. the token never goes into the output or an error text.
export async function pushToken(_options: PushOptions, _deps: PushDeps): Promise<GoogleTokenImportResponse> {
  throw new Error('not built: pushToken');
}

// TODO(m7 push): build it. it loads .env and okc.config.json, opens the store of the secrets block, and prints one
// line for the owner.
export async function main(_argv: string[]): Promise<number> {
  throw new Error('not built: the google:push command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
