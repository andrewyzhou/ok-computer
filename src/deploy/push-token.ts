import { pathToFileURL } from 'node:url';
import { loadConfig, loadDotEnv } from '../config/load.js';
import type { GoogleTokenImportRequest, GoogleTokenImportResponse } from '../dashboard/types.js';
import { tokenRef } from '../google/accounts.js';
import type { SecretStore } from '../integrations/secrets.js';
import { redact, registerSecret } from '../observability/redact.js';
import { createSecretVault } from '../secrets/index.js';

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

export const PUSH_USAGE = [
  'usage: npm run google:push -- <alias> --to <https url of the server dashboard>',
  'set OKC_REMOTE_TOKEN to the DASHBOARD_TOKEN of the server first. It is not the DASHBOARD_TOKEN of this desktop.',
].join('\n');

// the same rule as an alias in the google block of the config.
const ALIAS = /^[a-z][a-z0-9-]{0,15}$/;
// plain http is only for a server on this machine, for example a local docker container or a test.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TIMEOUT_MS = 30_000;

export function parsePushArgs(argv: string[]): PushOptions | { error: string } {
  let alias: string | undefined;
  let to: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--to') {
      if (to !== undefined || i + 1 >= argv.length) return { error: PUSH_USAGE };
      to = argv[++i];
    } else if (arg.startsWith('--to=')) {
      if (to !== undefined) return { error: PUSH_USAGE };
      to = arg.slice('--to='.length);
    } else if (arg.startsWith('-') || alias !== undefined) {
      return { error: PUSH_USAGE };
    } else {
      alias = arg;
    }
  }
  if (alias === undefined || !ALIAS.test(alias) || to === undefined) return { error: PUSH_USAGE };
  const url = checkUrl(to);
  if (url === undefined) return { error: PUSH_USAGE };
  return { alias, to: url };
}

// the token goes in an authorization header, so the url must be https unless the server is on this machine. the
// route is joined to the address, so a query, a fragment or a user name would move it out of the path. the answer is
// the origin and the path of the address without a trailing slash.
function checkUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return undefined;
  if (url.search || url.hash || text.includes('?') || text.includes('#') || url.username || url.password) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export async function pushToken(options: PushOptions, deps: PushDeps): Promise<GoogleTokenImportResponse> {
  // the server token goes in the header, so the redactor hides it in each message too.
  registerSecret(deps.token);
  try {
    return await send(options, deps);
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err)));
  }
}

async function send(options: PushOptions, deps: PushDeps): Promise<GoogleTokenImportResponse> {
  const ref = tokenRef(options.alias);
  const refreshToken = await deps.secrets.get(ref);
  if (!refreshToken) throw new Error(`sign in to ${options.alias} on this desktop first (Dashboard, Google, Connect).`);
  registerSecret(refreshToken, ref);
  const body: GoogleTokenImportRequest = { refreshToken, clientId: deps.clientId };
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${options.to}/api/google/accounts/${encodeURIComponent(options.alias)}/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // fetch would send the same body, with the refresh token, to the address of a 307 or 308. that address can be
      // plain http or another host, so a redirect is an error.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // the error of fetch can quote the request, so the message only names the address.
    throw new Error(`could not reach ${options.to}`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`the server answered ${response.status}, a redirect. Give the address of the dashboard itself in --to.`);
  }
  if (response.status === 401) throw new Error('the server refused OKC_REMOTE_TOKEN. Use the DASHBOARD_TOKEN of the server.');
  if (!response.ok) throw new Error(`the server answered ${response.status}: ${await errorText(response)}`);
  return (await response.json()) as GoogleTokenImportResponse;
}

// the dashboard answers an error with {error}. another body, for example a proxy page, gives its status text.
async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch {
    // the body is not json, so the status text says what happened.
  }
  return response.statusText || 'no error text';
}

// it reads the config and the store of the secrets block only. it does not open the database or take the instance
// lock, so it works while the desktop service runs.
export async function main(argv: string[]): Promise<number> {
  const fail = (message: string) => {
    process.stderr.write(`${redact(message)}\n`);
    return 1;
  };
  const options = parsePushArgs(argv);
  if ('error' in options) return fail(options.error);
  loadDotEnv();
  const loaded = loadConfig();
  if (!loaded.ok) return fail(loaded.error);
  const config = loaded.value;
  if (!config.google) return fail('okc.config.json has no google block. See docs/setup/google.md.');
  if (!config.google.accounts.some((each) => each.alias === options.alias)) {
    return fail(`${options.alias} is not an account in the google block of okc.config.json.`);
  }
  const token = process.env.OKC_REMOTE_TOKEN;
  if (!token) return fail(`OKC_REMOTE_TOKEN is not set.\n${PUSH_USAGE}`);
  try {
    const { store } = createSecretVault(config.secrets);
    const answer = await pushToken(options, { secrets: store, clientId: config.google.clientId, token });
    const who = answer.email ? ` (${answer.email})` : '';
    process.stdout.write(`the server stored the google token of ${answer.alias}${who}.\n`);
    return 0;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${redact(err instanceof Error ? err.message : String(err))}\n`);
      process.exit(1);
    },
  );
}
