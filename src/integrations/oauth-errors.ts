// the web api of slack answers every error with http 200 and { ok: false, error }. the sdk reads such a token answer
// as an oauth error with the code of slack, for example invalid_refresh_token. it then keeps the dead tokens, so each
// restart refreshes again and tells the owner again, and a rate limit looks like a revoked sign-in. this wrapper turns
// such an answer of a token request into the rfc 6749 form that the sdk and the sign-in log know. a server that follows
// the rfc never answers a token request with ok: false, so the wrapper changes nothing for it.

const GRANT = new Set(['invalid_grant', 'invalid_refresh_token', 'invalid_code', 'code_already_used', 'code_expired', 'token_revoked', 'token_expired']);
const CLIENT = new Set(['invalid_client', 'invalid_client_id', 'bad_client_secret', 'bad_redirect_uri']);
// these say that the sign-in server cannot work now. the tokens can still be good.
const DOWN = new Set(['ratelimited', 'service_unavailable', 'fatal_error', 'internal_error', 'request_timeout', 'temporarily_unavailable']);

export function oauthCode(serverCode: string): string {
  if (GRANT.has(serverCode)) return 'invalid_grant';
  if (CLIENT.has(serverCode)) return 'invalid_client';
  if (DOWN.has(serverCode)) return 'temporarily_unavailable';
  return 'invalid_request';
}

export function normalizeTokenErrors(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    const body = init?.body;
    const params = body instanceof URLSearchParams ? body : typeof body === 'string' ? new URLSearchParams(body) : undefined;
    if (init?.method !== 'POST' || !params?.has('grant_type') || response.status !== 200) return response;
    let json: { ok?: unknown; error?: unknown; access_token?: unknown };
    try {
      json = (await response.clone().json()) as typeof json;
    } catch {
      return response;
    }
    if (json?.ok !== false || json.access_token !== undefined) return response;
    const error = typeof json.error === 'string' ? json.error : 'unknown_error';
    return new Response(JSON.stringify({ error: oauthCode(error), error_description: `the server said ${error}` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };
}
