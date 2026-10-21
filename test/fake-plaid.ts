import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PlaidAccountWire, PlaidStreamWire, PlaidTransactionWire } from '../src/plaid/client.js';

// a local http server shaped like the rest api of plaid, for the calls of src/plaid/client.ts. tests run the real
// client against it, so the error shapes and the paging are the ones of plaid. each call checks client_id and secret
// as plaid does, and an access token that the server did not give gets INVALID_ACCESS_TOKEN. a fault makes a route fail
// on purpose. nothing here talks to plaid.

export const FAKE_CLIENT_ID = 'fake-client-id-0001';
export const FAKE_SECRET = 'fake-secret-0123456789abcdef';

export interface FakeItem {
  itemId: string;
  institutionId: string;
  institutionName: string;
  accounts: PlaidAccountWire[];
  // the transactions that /transactions/sync and /transactions/get give, oldest first.
  transactions: PlaidTransactionWire[];
  // the outflow streams of /transactions/recurring/get. inflow streams are always empty.
  outflowStreams: PlaidStreamWire[];
  // the error of /item/get, for example { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' }.
  error?: { error_type: string; error_code: string; error_message: string; display_message?: string | null } | null;
  consentExpirationTime?: string | null;
  removed?: boolean;
}

export interface FakeFault {
  status: number;
  error_type: string;
  error_code: string;
  error_message?: string;
  display_message?: string | null;
  // the calls that fail before the route works again. without it, every call fails.
  times?: number;
}

export interface FakePlaidRequest {
  path: string;
  body: Record<string, unknown>;
}

export interface FakePlaid {
  url: string;
  // every request, in order. the body holds the secret and the token, so a test can check what was sent.
  requests: FakePlaidRequest[];
  // adds a bank that the next exchange of publicToken links. it gives the public token for onSuccess.
  addLinkable(item: FakeItem): string;
  // the item of an access token, to change its data between syncs.
  itemOf(accessToken: string): FakeItem | undefined;
  accessTokenOf(itemId: string): string | undefined;
  // a route that fails, for example fault('/transactions/recurring/get', { status: 400, error_type: 'INVALID_REQUEST', error_code: 'PRODUCTS_NOT_SUPPORTED' }).
  fault(path: string, fault: FakeFault | null): void;
  // whether /transactions/recurring/get works. false answers PRODUCTS_NOT_SUPPORTED, as on a plan without it.
  recurring: boolean;
  // the page size of /transactions/sync when the request gives no count.
  pageSize: number;
  close(): Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const requestId = () => randomBytes(4).toString('hex');

const plaidError = (res: ServerResponse, status: number, type: string, code: string, message: string, display: string | null = null) =>
  send(res, status, { error_type: type, error_code: code, error_message: message, display_message: display, request_id: requestId() });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function startFakePlaid(): Promise<FakePlaid> {
  const linkable = new Map<string, FakeItem>();
  const tokens = new Map<string, FakeItem>();
  const faults = new Map<string, FakeFault>();
  const requests: FakePlaidRequest[] = [];

  const fake: FakePlaid = {
    url: '',
    requests,
    recurring: true,
    pageSize: 100,
    addLinkable(item) {
      const publicToken = `public-sandbox-${randomBytes(6).toString('hex')}`;
      linkable.set(publicToken, item);
      return publicToken;
    },
    itemOf: (accessToken) => tokens.get(accessToken),
    accessTokenOf: (itemId) => [...tokens.entries()].find(([, item]) => item.itemId === itemId)?.[0],
    fault(path, fault) {
      if (fault) faults.set(path, fault);
      else faults.delete(path);
    },
    close: () => new Promise((done) => server.close(() => done())),
  };

  const itemFor = (res: ServerResponse, body: Record<string, unknown>): FakeItem | undefined => {
    const item = tokens.get(String(body.access_token ?? ''));
    if (!item || item.removed) {
      plaidError(res, 400, 'INVALID_INPUT', 'INVALID_ACCESS_TOKEN', 'provided access token is in an invalid format or does not exist');
      return undefined;
    }
    return item;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://fake').pathname;
      const body = await readJson(req);
      if (req.method !== 'POST' || !body) return plaidError(res, 400, 'INVALID_REQUEST', 'INVALID_BODY', 'body could not be parsed as json');
      requests.push({ path, body });
      if (body.client_id !== FAKE_CLIENT_ID || body.secret !== FAKE_SECRET) {
        return plaidError(res, 400, 'INVALID_INPUT', 'INVALID_API_KEYS', 'invalid client_id or secret provided');
      }
      const fault = faults.get(path);
      if (fault) {
        if (fault.times !== undefined && --fault.times <= 0) faults.delete(path);
        return plaidError(res, fault.status, fault.error_type, fault.error_code, fault.error_message ?? fault.error_code.toLowerCase(), fault.display_message ?? null);
      }
      switch (path) {
        case '/link/token/create': {
          const user = body.user as { client_user_id?: unknown } | undefined;
          if (!user?.client_user_id) return plaidError(res, 400, 'INVALID_REQUEST', 'MISSING_FIELDS', 'the following required fields are missing: user.client_user_id');
          if (body.access_token !== undefined && !tokens.has(String(body.access_token))) {
            return plaidError(res, 400, 'INVALID_INPUT', 'INVALID_ACCESS_TOKEN', 'provided access token is in an invalid format or does not exist');
          }
          return send(res, 200, { link_token: `link-sandbox-${randomBytes(8).toString('hex')}`, expiration: new Date(Date.now() + 4 * 3600_000).toISOString(), request_id: requestId() });
        }
        case '/item/public_token/exchange': {
          const item = linkable.get(String(body.public_token ?? ''));
          if (!item) return plaidError(res, 400, 'INVALID_INPUT', 'INVALID_PUBLIC_TOKEN', 'provided public token is in an invalid format or does not exist');
          linkable.delete(String(body.public_token));
          const accessToken = `access-sandbox-${randomBytes(12).toString('hex')}`;
          tokens.set(accessToken, item);
          return send(res, 200, { access_token: accessToken, item_id: item.itemId, request_id: requestId() });
        }
        case '/item/get': {
          const item = itemFor(res, body);
          if (!item) return;
          return send(res, 200, {
            item: { item_id: item.itemId, institution_id: item.institutionId, error: item.error ?? null, consent_expiration_time: item.consentExpirationTime ?? null },
            request_id: requestId(),
          });
        }
        case '/institutions/get_by_id': {
          const item = [...tokens.values(), ...linkable.values()].find((each) => each.institutionId === body.institution_id);
          if (!item) return plaidError(res, 400, 'INVALID_INPUT', 'INVALID_INSTITUTION', 'invalid institution_id provided');
          return send(res, 200, { institution: { institution_id: item.institutionId, name: item.institutionName }, request_id: requestId() });
        }
        case '/accounts/get': {
          const item = itemFor(res, body);
          if (!item) return;
          if (item.error) return plaidError(res, 400, item.error.error_type, item.error.error_code, item.error.error_message, item.error.display_message ?? null);
          return send(res, 200, { accounts: item.accounts, item: { item_id: item.itemId }, request_id: requestId() });
        }
        case '/transactions/sync': {
          const item = itemFor(res, body);
          if (!item) return;
          if (item.error) return plaidError(res, 400, item.error.error_type, item.error.error_code, item.error.error_message, item.error.display_message ?? null);
          // the cursor is the count of transactions that the caller has seen. a removed or changed transaction is not
          // modelled here; a test edits item.transactions and starts again from an empty cursor for that.
          const start = body.cursor ? Number(Buffer.from(String(body.cursor), 'base64url').toString('utf8')) : 0;
          if (!Number.isInteger(start) || start < 0) return plaidError(res, 400, 'INVALID_INPUT', 'INVALID_CURSOR', 'cursor is invalid');
          const count = typeof body.count === 'number' ? body.count : fake.pageSize;
          const page = item.transactions.slice(start, start + count);
          const next = start + page.length;
          return send(res, 200, {
            added: page,
            modified: [],
            removed: [],
            next_cursor: Buffer.from(String(next)).toString('base64url'),
            has_more: next < item.transactions.length,
            accounts: item.accounts,
            request_id: requestId(),
          });
        }
        case '/transactions/recurring/get': {
          const item = itemFor(res, body);
          if (!item) return;
          if (!fake.recurring) return plaidError(res, 400, 'INVALID_REQUEST', 'PRODUCTS_NOT_SUPPORTED', 'the recurring transactions product is not enabled for this client');
          return send(res, 200, { inflow_streams: [], outflow_streams: item.outflowStreams, updated_datetime: new Date().toISOString(), request_id: requestId() });
        }
        case '/transactions/get': {
          const item = itemFor(res, body);
          if (!item) return;
          const startDate = String(body.start_date ?? '');
          const endDate = String(body.end_date ?? '');
          const options = (body.options ?? {}) as { offset?: number; count?: number };
          const inRange = item.transactions.filter((each) => each.date >= startDate && each.date <= endDate).sort((a, b) => (a.date < b.date ? 1 : -1));
          const offset = options.offset ?? 0;
          const count = options.count ?? 100;
          return send(res, 200, { transactions: inRange.slice(offset, offset + count), total_transactions: inRange.length, accounts: item.accounts, request_id: requestId() });
        }
        case '/item/remove': {
          const item = itemFor(res, body);
          if (!item) return;
          item.removed = true;
          return send(res, 200, { request_id: requestId() });
        }
        default:
          return plaidError(res, 404, 'INVALID_REQUEST', 'NOT_FOUND', `unknown route ${path}`);
      }
    })().catch((err: unknown) => send(res, 500, { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: String(err), request_id: requestId() }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
