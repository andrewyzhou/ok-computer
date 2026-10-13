import type { BrowserContext, CDPSession, Page, Request, Route } from 'playwright-core';
import { checkHost, type Egress } from '../web/egress.js';

export interface Blocked {
  url: string;
  reason: string;
}

export interface Sent {
  method: string;
  url: string;
}

// the rules of one tab: its allowlist, and whether the current action may send data.
export interface TabRules {
  allows(host: string): boolean;
  submitting(): boolean;
  // top is true for a navigation of the page itself, not of a frame in it.
  onBlocked(blocked: Blocked, top: boolean): void;
  onSent(sent: Sent): void;
}

// an entry allows its host and the subdomains of the host. "www." is not part of an entry, so www.shop.example and
// shop.example are the same site.
export const siteOf = (host: string) => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
export const allowedBy = (list: Iterable<string>, host: string) => {
  const site = siteOf(host);
  for (const entry of list) if (site === entry || site.endsWith(`.${entry}`)) return true;
  return false;
};

// the name check costs a lookup. a tab loads many resources from few hosts, so the answer is kept for a short time.
function cachedCheck(egress: Egress) {
  const cache = new Map<string, { at: number; result: Promise<Awaited<ReturnType<typeof checkHost>>> }>();
  return (host: string) => {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < 30_000) return hit.result;
    const result = checkHost(egress, host);
    cache.set(host, { at: Date.now(), result });
    return result;
  };
}

export type Verdict = { ok: true } | { ok: false; reason: string };

// these methods only read. every other method can carry data that the agent typed, also from a script (fetch, xhr,
// a beacon), so only an approved submit may send it.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// one decision for both layers. a document is a page or a frame, and it must be on the allowlist. every other request
// only needs a public address, because a page loads its images and scripts from many hosts, and the page already has
// its own data.
export async function judge(check: ReturnType<typeof cachedCheck>, rules: TabRules, url: string, document: boolean, method: string): Promise<Verdict> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'the address is not valid' };
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') return { ok: true };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: `the scheme ${parsed.protocol} is refused` };
  if (document && !rules.allows(parsed.hostname)) return { ok: false, reason: `${parsed.hostname} is not on the allowlist of this task` };
  if (!READ_METHODS.has(method) && !rules.submitting()) {
    return { ok: false, reason: `the page tried to send data (${method}) outside an approved submit. To send a form, use browser_submit, which the owner approves` };
  }
  const host = await check(parsed.hostname);
  return host.ok ? { ok: true } : { ok: false, reason: host.reason };
}

// both layers can see the same request, so each verdict goes to the tab rules through this one place.
function report(rules: TabRules, url: string, method: string, top: boolean, verdict: Verdict): void {
  if (!verdict.ok) rules.onBlocked({ url, reason: verdict.reason }, top);
  else if (!READ_METHODS.has(method)) rules.onSent({ method, url });
}

interface Paused {
  requestId: string;
  frameId: string;
  request: { url: string; method: string };
  resourceType: string;
}

// playwright calls a route only for the first address of a redirect chain (probe p1: a 302 from an allowed host
// reached the off-list host). a cdp Fetch session on the tab pauses every hop (probe p2), so it checks the hops.
export async function guardTab(cdp: CDPSession, egress: Egress, rules: TabRules): Promise<void> {
  const check = cachedCheck(egress);
  // the main frame of a page target has the id of the target.
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  cdp.on('Fetch.requestPaused', (event: Paused) => {
    void (async () => {
      const document = event.resourceType === 'Document';
      const verdict = await judge(check, rules, event.request.url, document, event.request.method);
      report(rules, event.request.url, event.request.method, document && event.frameId === targetInfo.targetId, verdict);
      if (verdict.ok) return cdp.send('Fetch.continueRequest', { requestId: event.requestId });
      return cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    })().catch(() => {
      // the tab closed while the request waited. chrome drops the request with the tab.
    });
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

const pageOf = (request: Request): Page | undefined => {
  try {
    return request.frame().page();
  } catch {
    // a service worker request has no frame.
    return undefined;
  }
};

// the context route sees the first request of every tab, also of a popup, before cdp can attach to it. a request of
// a tab that the app did not open is refused, so a popup never loads. requests of the app's tabs go to the same
// judge, which covers frames that chrome runs in another process, where the tab's cdp session does not see them.
export async function guardContext(
  context: BrowserContext,
  egress: Egress,
  rulesOf: (page: Page) => TabRules | undefined,
  onPopup: (url: string) => void,
): Promise<void> {
  const check = cachedCheck(egress);
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const page = pageOf(request);
    const rules = page ? rulesOf(page) : undefined;
    if (!page || !rules) {
      onPopup(request.url());
      return route.abort('blockedbyclient').catch(() => undefined);
    }
    const document = request.isNavigationRequest();
    const verdict = await judge(check, rules, request.url(), document, request.method());
    report(rules, request.url(), request.method(), document && request.frame() === page.mainFrame(), verdict);
    if (verdict.ok) return route.fallback().catch(() => undefined);
    return route.abort('blockedbyclient').catch(() => undefined);
  });
  // cdp Fetch does not pause web sockets, so the route checks them too. a socket only needs a public address.
  await context.routeWebSocket(/.*/, async (socket) => {
    const host = new URL(socket.url()).hostname;
    const verdict = await check(host);
    if (verdict.ok) return void socket.connectToServer();
    return socket.close({ code: 1008, reason: 'blocked' });
  });
}
