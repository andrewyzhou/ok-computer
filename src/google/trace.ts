import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redact, redactedJson } from '../observability/redact.js';
import { headOf } from '../text.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';

// the work that a request belongs to: a tool call (runId and toolCallId), a poll run (runId), or a sign-in (neither).
// a token refresh runs inside the same work, so it shows next to the call that needed it.
export interface RequestContext {
  account?: string;
  runId?: string;
  toolCallId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// these fields hold a token, a code, a verifier or the client secret. the redactor knows a token only after the app
// saw it, and a code or a verifier is never registered, so the trace removes these fields by name first.
const SECRET_FIELDS = new Set(['access_token', 'refresh_token', 'id_token', 'code', 'code_verifier', 'client_secret', 'assertion', 'token']);
const HIDDEN = '[redacted]';
// a small answer stays in the row. a larger one goes to the blob store, and the row keeps its start.
const INLINE_LIMIT = 8_000;
const PREVIEW = 2_000;

function scrubbed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubbed);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, SECRET_FIELDS.has(key) ? HIDDEN : scrubbed(each)]));
  }
  return value;
}

// json and form bodies lose their secret fields. other text only goes through the redactor.
export function bodyText(body: unknown): string | null {
  if (body === undefined || body === null || body === '') return null;
  if (body instanceof URLSearchParams) return redactedJson(scrubbed(Object.fromEntries(body)));
  if (typeof body !== 'string') return `[a body of type ${Object.prototype.toString.call(body)}]`;
  try {
    return redactedJson(scrubbed(JSON.parse(body)));
  } catch {
    if (/^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(body)) return redactedJson(scrubbed(Object.fromEntries(new URLSearchParams(body))));
    return redact(body);
  }
}

// the trace keeps the host, the path and the query. a query can hold a code or text from the model.
function shownUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (SECRET_FIELDS.has(key)) url.searchParams.set(key, HIDDEN);
    return redact(`${url.host}${url.pathname}${url.search}`);
  } catch {
    return redact(raw);
  }
}

export interface Answer {
  status?: number;
  body?: string;
  error?: string;
}

// start writes the row of a request before it leaves, and gives the function that adds the answer.
export type RequestTrace = (method: string, url: string, body: unknown) => (answer: Answer) => void;

// a request that the trace cannot record does not leave. the code tells the caller that nothing was sent.
export class TraceFailed extends Error {
  readonly code = 'ETRACE';
}

export function createRequestTrace(deps: { db: Db; blobs: BlobStore; logger: Logger; clock: Clock }): RequestTrace {
  const { db, blobs, logger, clock } = deps;
  return (method, url, body) => {
    const context = requestContext.getStore() ?? {};
    let id: number;
    try {
      const row = db
        .prepare('INSERT INTO google_requests (account, runId, toolCallId, method, url, request, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .get(context.account ?? null, context.runId ?? null, context.toolCallId ?? null, method.toUpperCase(), shownUrl(url), bodyText(body), clock().toISOString());
      id = Number(row!.id);
    } catch (err) {
      logger.error('google request trace write failed, so the request did not leave', { ...context, err });
      throw new TraceFailed(`the request was not sent, because its trace could not be written: ${errorText(err)}`);
    }
    const started = performance.now();
    return (answer) => {
      try {
        const text = answer.body === undefined ? null : (bodyText(answer.body) ?? '');
        let blob: string | null = null;
        if (text !== null && text.length > INLINE_LIMIT) {
          try {
            blob = blobs.put(text);
          } catch (err) {
            logger.error('google answer blob write failed', { requestId: id, err });
          }
        }
        db.prepare('UPDATE google_requests SET status = ?, response = ?, responseBlob = ?, error = ?, latencyMs = ? WHERE id = ?').run(
          answer.status ?? null,
          text !== null && text.length > INLINE_LIMIT ? headOf(text, PREVIEW) : text,
          blob,
          answer.error === undefined ? null : redact(answer.error),
          Math.round(performance.now() - started),
          id,
        );
      } catch (err) {
        logger.error('google answer trace write failed', { requestId: id, err });
      }
    };
  };
}

// every request of the google clients goes through this fetch: the api calls, the token refresh, the code exchange
// and the revoke. a header is never stored, so the authorization header never reaches the trace.
export function tracedFetch(trace: RequestTrace, send: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const done = trace(init?.method ?? (input instanceof Request ? input.method : 'GET'), url, init?.body);
    let response: Response;
    try {
      response = await send(input, init);
    } catch (err) {
      done({ error: errorText(err) });
      throw err;
    }
    try {
      done({ status: response.status, body: await response.clone().text() });
    } catch (err) {
      done({ status: response.status, error: `the answer could not be read for the trace: ${errorText(err)}` });
    }
    return response;
  };
}
