import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// a local http server shaped like the google apis that the integration uses. tests run the real sdk against it, so the
// error shapes, the token refresh and the headers are the real ones. faults make a route fail on purpose.

export interface FakeMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  headers: Record<string, string>;
  snippet?: string;
  body?: string;
  internalDate?: string;
}

export interface FakeEvent {
  id: string;
  summary?: string;
  status?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: Array<{ email: string; self?: boolean; responseStatus?: string }>;
  updated?: string;
}

interface Mailbox {
  email: string;
  messages: Map<string, FakeMessage>;
  history: Array<{ id: number; messageId: string }>;
  historyId: number;
  // a start id below this one gets a 404, as google does for a history id that is too old.
  oldestHistoryId: number;
  drafts: Map<string, { message: FakeMessage; sent?: string }>;
  events: Map<string, FakeEvent & { version: number }>;
  calendarVersion: number;
  // a sync token older than this version gets a 410.
  oldestSyncVersion: number;
}

export interface Fault {
  // the route matches when the method and the path start match, for example 'GET /gmail/v1/users/me/history'.
  route: string;
  // the fault applies only when the query contains this text, for example pageToken= for a later page.
  contains?: string;
  status?: number;
  body?: unknown;
  // reset closes the socket without an answer. late runs the route, then closes the socket without the answer.
  reset?: boolean;
  late?: boolean;
  // echoAuth puts the authorization header and the body of the request in the error message.
  echoAuth?: boolean;
  // delayMs computes the answer at once and sends it after this many milliseconds.
  delayMs?: number;
  times?: number;
}

export interface FakeGoogle {
  url: string;
  requests: Array<{ method: string; path: string; authorization?: string; body: string }>;
  // the raw text of each message that a draft send delivered.
  sent: Array<{ alias: string; raw: string }>;
  mailbox(alias: string): Mailbox;
  addAccount(alias: string, email: string, refreshToken: string): void;
  revoke(refreshToken: string): void;
  deliver(alias: string, message: FakeMessage): void;
  upsertEvent(alias: string, event: FakeEvent): void;
  fault(fault: Fault): void;
  clearFaults(): void;
  // the scopes that the next code exchange grants.
  grant: string[];
  // the authorization code that the token endpoint accepts.
  code: string;
  // the account of the next code exchange.
  nextSignIn: { alias: string; refreshToken: string } | undefined;
  close(): Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const mailboxes = new Map<string, Mailbox>();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Map<string, string>();
  const faults: Fault[] = [];
  const requests: FakeGoogle['requests'] = [];
  let accessCounter = 0;
  let draftCounter = 0;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const apiError = (res: ServerResponse, status: number, message: string, reason = 'backendError') =>
    json(res, status, { error: { code: status, message, errors: [{ reason, message }] } });

  const newAccess = (alias: string) => {
    const token = `ya29.fake-access-${alias}-${++accessCounter}-${'x'.repeat(20)}`;
    accessTokens.set(token, alias);
    return token;
  };

  const metadata = (message: FakeMessage) => ({
    id: message.id,
    threadId: message.threadId ?? message.id,
    labelIds: message.labelIds ?? ['INBOX'],
    snippet: message.snippet ?? '',
    internalDate: message.internalDate ?? String(Date.parse(message.headers.Date ?? '2026-10-13T00:00:00Z')),
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries(message.headers).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(message.body ?? '').toString('base64url'), size: (message.body ?? '').length },
    },
  });

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => {
    const path = url.pathname;
    if (path === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'refresh_token') {
        const alias = refreshTokens.get(form.get('refresh_token') ?? '');
        if (!alias) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return json(res, 200, { access_token: newAccess(alias), expires_in: 3599, token_type: 'Bearer', scope: fake.grant.join(' ') });
      }
      if (form.get('grant_type') === 'authorization_code') {
        const next = fake.nextSignIn;
        if (!next || form.get('code') !== fake.code || !form.get('code_verifier')) return json(res, 400, { error: 'invalid_grant' });
        refreshTokens.set(next.refreshToken, next.alias);
        return json(res, 200, { access_token: newAccess(next.alias), refresh_token: next.refreshToken, expires_in: 3599, token_type: 'Bearer', scope: fake.grant.join(' ') });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (path === '/revoke') {
      const token = new URLSearchParams(body).get('token') ?? url.searchParams.get('token') ?? '';
      refreshTokens.delete(token);
      return json(res, 200, {});
    }
    const alias = accessTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!alias) return apiError(res, 401, 'Request had invalid authentication credentials.', 'authError');
    const box = mailboxes.get(alias)!;

    let match: RegExpExecArray | null;
    if (path === '/gmail/v1/users/me/profile') return json(res, 200, { emailAddress: box.email, historyId: String(box.historyId) });
    if (path === '/gmail/v1/users/me/history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < box.oldestHistoryId) return apiError(res, 404, 'Requested entity was not found.', 'notFound');
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const from = Number(url.searchParams.get('pageToken') ?? 0);
      const records = box.history.filter((each) => each.id > start);
      const page = records.slice(from, from + max);
      return json(res, 200, {
        historyId: String(box.historyId),
        ...(from + max < records.length ? { nextPageToken: String(from + max) } : {}),
        ...(page.length
          ? {
              history: page.map((each) => {
                const message = box.messages.get(each.messageId);
                return { id: String(each.id), messagesAdded: [{ message: { id: each.messageId, threadId: message?.threadId ?? each.messageId, labelIds: message?.labelIds ?? ['INBOX'] } }] };
              }),
            }
          : {}),
      });
    }
    if (path === '/gmail/v1/users/me/messages' && req.method === 'GET') {
      const all = [...box.messages.values()].filter((each) => (each.labelIds ?? ['INBOX']).includes('INBOX')).reverse();
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      return json(res, 200, { messages: all.slice(0, max).map((each) => ({ id: each.id, threadId: each.threadId ?? each.id })), resultSizeEstimate: all.length });
    }
    if ((match = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const message = box.messages.get(match[1]!);
      return message ? json(res, 200, metadata(message)) : apiError(res, 404, 'Requested entity was not found.', 'notFound');
    }
    if ((match = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(path))) {
      const messages = [...box.messages.values()].filter((each) => (each.threadId ?? each.id) === match![1]);
      return messages.length ? json(res, 200, { id: match[1], messages: messages.map(metadata) }) : apiError(res, 404, 'Requested entity was not found.', 'notFound');
    }
    if (path === '/gmail/v1/users/me/drafts' && req.method === 'POST') {
      const id = `d${++draftCounter}`;
      const raw = (JSON.parse(body) as { message: { raw: string } }).message.raw;
      box.drafts.set(id, { message: { id: `m-${id}`, headers: {}, body: Buffer.from(raw, 'base64url').toString('utf8') } });
      return json(res, 200, { id, message: { id: `m-${id}` } });
    }
    if (path === '/gmail/v1/users/me/drafts/send') {
      const id = (JSON.parse(body) as { id: string }).id;
      const draft = box.drafts.get(id);
      if (!draft) return apiError(res, 404, 'Requested entity was not found.', 'notFound');
      box.drafts.delete(id);
      draft.sent = draft.message.id;
      sent.push({ alias, raw: draft.message.body ?? '' });
      return json(res, 200, { id: draft.message.id, labelIds: ['SENT'] });
    }
    if ((match = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(path))) {
      const draft = box.drafts.get(match[1]!);
      return draft ? json(res, 200, { id: match[1], message: { id: draft.message.id } }) : apiError(res, 404, 'Requested entity was not found.', 'notFound');
    }
    if (path === '/gmail/v1/users/me/labels') return json(res, 200, { labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_1', name: 'school' }] });
    if (path === '/gmail/v1/users/me/messages/batchModify') {
      const change = JSON.parse(body) as { ids: string[]; addLabelIds?: string[]; removeLabelIds?: string[] };
      for (const id of change.ids) {
        const message = box.messages.get(id);
        if (message) message.labelIds = [...(message.labelIds ?? ['INBOX']).filter((label) => !change.removeLabelIds?.includes(label)), ...(change.addLabelIds ?? [])];
      }
      res.writeHead(204).end();
      return;
    }
    if ((match = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(path))) {
      const event = box.events.get(decodeURIComponent(match[1]!));
      if (!event || event.status === 'cancelled') return apiError(res, req.method === 'DELETE' ? 410 : 404, 'Resource has been deleted', 'deleted');
      if (req.method === 'DELETE') {
        fake.upsertEvent(alias, { ...event, status: 'cancelled' });
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET') return json(res, 200, event);
      fake.upsertEvent(alias, { ...event, ...(JSON.parse(body) as Partial<FakeEvent>) });
      return json(res, 200, box.events.get(event.id));
    }
    if (path === '/calendar/v3/calendars/primary/events' && req.method === 'GET') {
      const syncToken = url.searchParams.get('syncToken');
      const since = syncToken ? Number(syncToken.replace('st-', '')) : 0;
      if (syncToken && since < box.oldestSyncVersion) return apiError(res, 410, 'Sync token is no longer valid, a full sync is required.', 'fullSyncRequired');
      const max = Number(url.searchParams.get('maxResults') ?? 250);
      const from = Number(url.searchParams.get('pageToken') ?? 0);
      // google keeps an event that ends after timeMin and starts before timeMax.
      const timeMin = url.searchParams.get('timeMin');
      const timeMax = url.searchParams.get('timeMax');
      const at = (when: { dateTime?: string; date?: string }) => Date.parse(when.dateTime ?? `${when.date}T00:00:00Z`);
      const changed = [...box.events.values()].filter(
        (each) =>
          each.version > since &&
          (syncToken || each.status !== 'cancelled') &&
          (!timeMin || at(each.end) > Date.parse(timeMin)) &&
          (!timeMax || at(each.start) < Date.parse(timeMax)),
      );
      if (url.searchParams.get('orderBy') === 'startTime') changed.sort((a, b) => at(a.start) - at(b.start));
      const page = changed.slice(from, from + max);
      const last = from + max >= changed.length;
      return json(res, 200, {
        items: page.map(({ version: _version, ...event }) => event),
        ...(last ? { nextSyncToken: `st-${box.calendarVersion}` } : { nextPageToken: String(from + max) }),
      });
    }
    if (path === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
      const event = JSON.parse(body) as FakeEvent;
      if (event.id && box.events.has(event.id)) return apiError(res, 409, 'The requested identifier already exists.', 'duplicate');
      const id = event.id ?? `ev${box.events.size + 1}`;
      fake.upsertEvent(alias, { ...event, id, organizer: { email: box.email, self: true } });
      return json(res, 200, { ...event, id, htmlLink: `https://calendar.example/${id}` });
    }
    return apiError(res, 404, `no fake route for ${req.method} ${path}`, 'notFound');
  };

  const sent: Array<{ alias: string; raw: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: req.method ?? '', path: url.pathname + url.search, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), body });
      const fault = faults.find((each) => `${req.method} ${url.pathname}`.startsWith(each.route) && (!each.contains || url.search.includes(each.contains)));
      if (fault) {
        if (fault.times !== undefined && --fault.times <= 0) faults.splice(faults.indexOf(fault), 1);
        if (fault.reset) return void req.socket.destroy();
        if (fault.delayMs) {
          // the route answers now, and the answer arrives later, as from a slow network.
          const held: Array<() => void> = [];
          const slow = {
            writeHead: (...args: Parameters<ServerResponse['writeHead']>) => (held.push(() => res.writeHead(...args)), slow),
            end: (...args: [unknown?]) => setTimeout(() => (held.forEach((each) => each()), res.end(...(args as []))), fault.delayMs),
          };
          return void route(req, slow as unknown as ServerResponse, url, body);
        }
        if (fault.late) {
          // the route acts, but the answer never arrives.
          const sink = { writeHead: () => sink, end: () => req.socket.destroy() } as unknown as ServerResponse;
          return void route(req, sink, url, body);
        }
        res.writeHead(fault.status ?? 500, { 'content-type': 'application/json' });
        // a careless server quotes the request in its error, with the token in it.
        const echo = fault.echoAuth ? ` for ${req.headers.authorization ?? ''} ${body}` : '';
        return void res.end(JSON.stringify(fault.body ?? { error: { code: fault.status ?? 500, message: `injected fault${echo}` } }));
      }
      void route(req, res, url, body).catch((err: unknown) => apiError(res, 500, String(err)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const fake: FakeGoogle = {
    url,
    requests,
    sent,
    grant: [],
    nextSignIn: undefined,
    code: 'good-code',
    mailbox: (alias) => mailboxes.get(alias)!,
    addAccount(alias, email, refreshToken) {
      refreshTokens.set(refreshToken, alias);
      mailboxes.set(alias, {
        email,
        messages: new Map(),
        history: [],
        historyId: 1000,
        oldestHistoryId: 0,
        drafts: new Map(),
        events: new Map(),
        calendarVersion: 1,
        oldestSyncVersion: 0,
      });
    },
    revoke(refreshToken) {
      // a revoke at google ends the refresh token and every access token of the account.
      const alias = refreshTokens.get(refreshToken);
      refreshTokens.delete(refreshToken);
      for (const [token, owner] of accessTokens) if (owner === alias) accessTokens.delete(token);
    },
    deliver(alias, message) {
      const box = mailboxes.get(alias)!;
      box.messages.set(message.id, message);
      box.history.push({ id: ++box.historyId, messageId: message.id });
    },
    upsertEvent(alias, event) {
      const box = mailboxes.get(alias)!;
      box.calendarVersion++;
      box.events.set(event.id, { status: 'confirmed', updated: new Date(Date.UTC(2026, 9, 13, 0, 0, box.calendarVersion)).toISOString(), ...event, version: box.calendarVersion });
    },
    fault: (fault) => void faults.push(fault),
    clearFaults: () => void faults.splice(0),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return fake;
}
