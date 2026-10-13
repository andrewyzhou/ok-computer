import { redact } from '../observability/redact.js';
import { headOf } from '../text.js';

// auth: google refused the sign-in (invalid_grant, or a 401 after a fresh token). only a new sign-in helps.
// client: google refused the oauth client (invalid_client). every account needs the owner to fix the client.
// scope: the token lacks a permission. only a new sign-in with the box ticked helps.
// not_found: 404. gone: 410, or a gmail history id that is too old. rate: 429 or a rate limit 403.
// transient: 5xx, a timeout or a network error. request: another 4xx.
// sent tells whether the request can have reached google. a refused connection never left the pc.
export type GoogleErrorKind = 'auth' | 'client' | 'scope' | 'not_found' | 'gone' | 'rate' | 'transient' | 'request';

export class GoogleError extends Error {
  override name = 'GoogleError';
  constructor(
    readonly kind: GoogleErrorKind,
    message: string,
    readonly status?: number,
    // false only when the request surely did not reach google. an answer, a timeout or a reset can follow the action.
    readonly reached = true,
  ) {
    super(message);
  }
}

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

interface Shape {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  config?: { url?: unknown };
  response?: { status?: unknown; data?: unknown };
}

// the http client of the sdk throws a GaxiosError for an answer, a timeout and a network error. its name is only
// "Error", and it marks itself with this registered symbol. any other error is a bug or a database error, and it
// must stay what it is.
const GAXIOS_ERROR = Symbol.for('gaxios-gaxios-error');

export function fromSdk(err: unknown): boolean {
  return err instanceof GoogleError || (err instanceof Error && GAXIOS_ERROR in err);
}

// toGoogleError keeps only the status, the reason and a short message. the error of the sdk holds the request
// config and the response, and a server can echo the authorization header in its message. none of that may reach a
// log, a trace row or the model. the message is redacted and short.
// the start of the text of a parked account whose client google refused. a new client lifts this park.
export const CLIENT_REFUSED = 'google refused the oauth client: ';

export function toGoogleError(err: unknown): GoogleError {
  if (err instanceof GoogleError) return err;
  const shape = (err ?? {}) as Shape;
  const status = typeof shape.response?.status === 'number' ? shape.response.status : typeof shape.status === 'number' ? shape.status : undefined;
  const data = (shape.response?.data ?? {}) as { error?: unknown; error_description?: unknown };
  const body = typeof data.error === 'object' && data.error !== null ? (data.error as { message?: unknown; errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> }) : undefined;
  const reasons = [...(body?.errors ?? []), ...(body?.details ?? [])].map((each) => String(each?.reason ?? ''));
  const said = typeof body?.message === 'string' ? body.message : typeof data.error_description === 'string' ? data.error_description : typeof shape.message === 'string' ? shape.message : 'unknown error';
  const text = (prefix: string) => redact(headOf(`${prefix}${said}`.replace(/\s+/g, ' '), 300));

  // a failed token request comes before the api request, so the api request never left.
  const tokenCall = /\/token(\?|$)/.test(String(shape.config?.url ?? ''));
  // the token endpoint answers invalid_grant for a revoked, expired or replaced refresh token.
  if (data.error === 'invalid_grant') return new GoogleError('auth', text('sign-in refused: '), status, false);
  if (data.error === 'invalid_client' || data.error === 'unauthorized_client') return new GoogleError('client', text(CLIENT_REFUSED), status, false);
  if (tokenCall) return new GoogleError('transient', text(`the token request failed${status ? ` with ${status}` : ''}: `), status, false);
  if (status === undefined) {
    const code = String(shape.code ?? (shape.cause as { code?: unknown } | undefined)?.code ?? '');
    return new GoogleError('transient', text(code ? `${code}: ` : ''), undefined, !NOT_SENT.has(code));
  }
  if (status === 401) return new GoogleError('auth', text('401: '), status);
  if (status === 403 && reasons.some((reason) => SCOPE_REASONS.has(reason))) return new GoogleError('scope', text('403: '), status);
  if (status === 429 || (status === 403 && reasons.some((reason) => RATE_REASONS.has(reason)))) return new GoogleError('rate', text(`${status}: `), status);
  if (status === 404) return new GoogleError('not_found', text('404: '), status);
  if (status === 410) return new GoogleError('gone', text('410: '), status);
  if (status >= 500) return new GoogleError('transient', text(`${status}: `), status);
  return new GoogleError('request', text(`${status}: `), status);
}
