import { describe, expect, it } from 'vitest';
import type { GoogleTokenImportResponse } from '../dashboard/types.js';
import { createMemorySecretStore } from '../integrations/secrets.js';
import { parsePushArgs, pushToken, type PushDeps } from './push-token.js';

const REFRESH = 'refresh-token-of-the-desktop-1234567890';
const SERVER_TOKEN = 'server-dashboard-token-abcdefghijkl';
const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const TO = 'https://okc.example.ts.net';

const OK: GoogleTokenImportResponse = {
  alias: 'personal',
  email: 'me@example.com',
  status: 'ok',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  storedAt: '2026-10-18T12:00:00.000Z',
};

interface Recorded {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { fn, calls };
}

function deps(fetchFn: typeof fetch, values: Record<string, string> = { 'google.personal': REFRESH }): PushDeps {
  return { secrets: createMemorySecretStore(values), clientId: CLIENT_ID, token: SERVER_TOKEN, fetch: fetchFn };
}

async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the promise did not reject');
}

describe('parsePushArgs', () => {
  it('takes the alias and --to in either order', () => {
    expect(parsePushArgs(['personal', '--to', TO])).toEqual({ alias: 'personal', to: TO });
    expect(parsePushArgs(['--to', TO, 'personal'])).toEqual({ alias: 'personal', to: TO });
  });

  it('takes --to= and strips one trailing slash', () => {
    expect(parsePushArgs(['school', `--to=${TO}/`])).toEqual({ alias: 'school', to: TO });
  });

  it('takes plain http only for a loopback host', () => {
    expect(parsePushArgs(['personal', '--to', 'http://127.0.0.1:8787'])).toEqual({ alias: 'personal', to: 'http://127.0.0.1:8787' });
    expect(parsePushArgs(['personal', '--to', 'http://localhost:8787/'])).toEqual({ alias: 'personal', to: 'http://localhost:8787' });
    expect(parsePushArgs(['personal', '--to', 'http://[::1]:8787'])).toEqual({ alias: 'personal', to: 'http://[::1]:8787' });
    expect(parsePushArgs(['personal', '--to', 'http://okc.example.ts.net'])).toHaveProperty('error');
    expect(parsePushArgs(['personal', '--to', 'ftp://127.0.0.1'])).toHaveProperty('error');
    expect(parsePushArgs(['personal', '--to', 'not a url'])).toHaveProperty('error');
  });

  it('refuses a bad alias', () => {
    expect(parsePushArgs(['Personal', '--to', TO])).toHaveProperty('error');
    expect(parsePushArgs(['1abc', '--to', TO])).toHaveProperty('error');
    expect(parsePushArgs(['a'.repeat(17), '--to', TO])).toHaveProperty('error');
  });

  it('refuses a missing --to and extra arguments, and names OKC_REMOTE_TOKEN', () => {
    const missing = parsePushArgs(['personal']);
    expect(missing).toHaveProperty('error');
    expect((missing as { error: string }).error).toContain('OKC_REMOTE_TOKEN');
    expect(parsePushArgs(['personal', '--to'])).toHaveProperty('error');
    expect(parsePushArgs(['--to', TO])).toHaveProperty('error');
    expect(parsePushArgs(['personal', 'school', '--to', TO])).toHaveProperty('error');
    expect(parsePushArgs(['personal', '--to', TO, '--to', TO])).toHaveProperty('error');
    expect(parsePushArgs(['personal', '--force', '--to', TO])).toHaveProperty('error');
  });

  // the route is joined to --to as text, so a query or a fragment moves the path out of the url.
  it('refuses an address with a query, a fragment or a user name', () => {
    for (const to of ['https://okc.example.ts.net/?x=1', 'https://okc.example.ts.net/#top', 'https://me:pw@okc.example.ts.net']) {
      expect(parsePushArgs(['personal', '--to', to]), to).toHaveProperty('error');
    }
  });

  it('keeps a path of the server and drops each trailing slash', () => {
    expect(parsePushArgs(['personal', '--to', `${TO}//`])).toEqual({ alias: 'personal', to: TO });
    expect(parsePushArgs(['personal', '--to', `${TO}/okc/`])).toEqual({ alias: 'personal', to: `${TO}/okc` });
  });
});

describe('pushToken', () => {
  it('posts the token of the desktop store to the import route', async () => {
    const fake = fakeFetch(() => Response.json(OK));
    await expect(pushToken({ alias: 'personal', to: TO }, deps(fake.fn))).resolves.toEqual(OK);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.url).toBe(`${TO}/api/google/accounts/personal/token`);
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toEqual({ authorization: `Bearer ${SERVER_TOKEN}`, 'content-type': 'application/json' });
    expect(JSON.parse(String(call!.init.body))).toEqual({ refreshToken: REFRESH, clientId: CLIENT_ID });
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks for a sign-in on the desktop when the store has no token', async () => {
    const fake = fakeFetch(() => Response.json(OK));
    const text = await message(pushToken({ alias: 'personal', to: TO }, deps(fake.fn, {})));
    expect(text).toBe('sign in to personal on this desktop first (Dashboard, Google, Connect).');
    expect(fake.calls).toHaveLength(0);
  });

  it('says which token a 401 needs', async () => {
    const fake = fakeFetch(() => Response.json({ error: 'sign in first' }, { status: 401 }));
    const text = await message(pushToken({ alias: 'personal', to: TO }, deps(fake.fn)));
    expect(text).toBe('the server refused OKC_REMOTE_TOKEN. Use the DASHBOARD_TOKEN of the server.');
  });

  it('gives the status and the error of another answer, without a secret', async () => {
    const fake = fakeFetch(() =>
      Response.json({ error: `the token belongs to other@example.com, not me@example.com (${REFRESH}, ${SERVER_TOKEN})` }, { status: 409 }),
    );
    const text = await message(pushToken({ alias: 'personal', to: TO }, deps(fake.fn)));
    expect(text).toMatch(/^the server answered 409: the token belongs to other@example.com, not me@example.com/);
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(SERVER_TOKEN);
  });

  it('gives the status text when the body is not json', async () => {
    const fake = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const text = await message(pushToken({ alias: 'personal', to: TO }, deps(fake.fn)));
    expect(text).toBe('the server answered 502: Bad Gateway');
  });

  it('names only the address when fetch throws', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError(`fetch failed for Bearer ${SERVER_TOKEN} with ${REFRESH}`);
    });
    const text = await message(pushToken({ alias: 'personal', to: TO }, deps(fake.fn)));
    expect(text).toBe(`could not reach ${TO}`);
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(SERVER_TOKEN);
  });
});
