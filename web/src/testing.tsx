import { configure, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App';

// the shared helpers of the web tests. a test file imports this file first. the shell loads each page with a dynamic
// import, and the first import of a page in a test file can take some seconds, so the find queries wait longer.
configure({ asyncUtilTimeout: 8000 });

type Data = { data: string };

// a fake of the browser stream. a test sends what the server sends: emit for an unnamed message, and emitNamed for
// an event with a name, for example ready or ping. each stream url has its own fake.
export class FakeEventSource {
  static last: FakeEventSource | undefined;
  static all: FakeEventSource[] = [];
  readyState = 1;
  onmessage: ((event: Data) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private named = new Map<string, Set<(event: Data) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
    FakeEventSource.all.push(this);
  }

  // the stream of a path, for example /api/chat/stream. the url can have a token after the path.
  static find(path: string): FakeEventSource | undefined {
    return FakeEventSource.all.findLast((source) => source.url.split('?')[0] === path);
  }

  addEventListener(name: string, listener: (event: Data) => void): void {
    if (!this.named.has(name)) this.named.set(name, new Set());
    this.named.get(name)!.add(listener);
  }

  removeEventListener(name: string, listener: (event: Data) => void): void {
    this.named.get(name)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(message: unknown): void {
    const event = { data: JSON.stringify(message) };
    this.onmessage?.(event);
    for (const listener of this.named.get('message') ?? []) listener(event);
  }

  emitNamed(name: string, data: unknown = {}): void {
    for (const listener of this.named.get(name) ?? []) listener({ data: JSON.stringify(data) });
  }
}

export function installEventSource(): void {
  vi.stubGlobal('EventSource', FakeEventSource);
}

export interface StubRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  init: RequestInit | undefined;
}

// a stub answers one route, for example 'GET /api/chats/:key/messages'. it gives a value, which goes out as json with
// status 200, or a Response.
export type StubRoutes = Record<string, (request: StubRequest) => unknown>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function matchStub(pattern: string, method: string, pathname: string): Record<string, string> | undefined {
  const [stubMethod, stubPath = ''] = pattern.split(' ', 2);
  if (stubMethod !== method) return undefined;
  const want = stubPath.split('/');
  const have = pathname.split('/');
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of want.entries()) {
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(have[index]!);
    else if (part !== have[index]) return undefined;
  }
  return params;
}

// the fetch of the page goes to the stubs first and then to the seeded dashboard. the new phase 5 endpoints are built
// in parallel, so a test of a new view stubs them here. calls holds each request for the checks of the test.
export function stubFetch(dashboard: { request(input: string, init?: RequestInit): Response | Promise<Response> } | null, routes: StubRoutes = {}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url: `${url.pathname}${url.search}`, body });
    for (const [pattern, handler] of Object.entries(routes)) {
      const params = matchStub(pattern, method, url.pathname);
      if (!params) continue;
      const result = await handler({ params, query: url.searchParams, body, init });
      return result instanceof Response ? result : json(result);
    }
    if (!dashboard) return json({ error: `no stub for ${method} ${url.pathname}` }, 404);
    return dashboard.request(String(input), init);
  });
  return calls;
}

export function openApp(hash: string) {
  location.hash = hash;
  return render(<App />);
}

// the queries of the main area only, so a word in the nav, the header or the status bar never matches.
export function inMain() {
  return within(screen.getByRole('main'));
}
