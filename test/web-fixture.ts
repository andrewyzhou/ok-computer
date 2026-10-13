import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { Egress } from '../src/web/egress.js';

// one local server plays several sites. the host name tells them apart: shop.test is the site of the task, evil.test
// is a site that the task must never reach, and cdn.test serves images. tests map every *.test name to 127.0.0.1.
export interface Fixture {
  port: number;
  url(host: string, path?: string): string;
  hits: Array<{ host: string; method: string; path: string; body: string }>;
  hitsOn(host: string): Array<{ method: string; path: string; body: string }>;
  // the search pages answer with this mode. ok gives results, captcha and consent give a wall, empty gives no result.
  google: 'ok' | 'captcha' | 'consent' | 'layout';
  close(): Promise<void>;
}

// the fixture egress allows only the fixture address, so other loopback addresses stand for the owner's network.
export function fixtureEgress(): Egress {
  return {
    resolve: async (host) => (host === 'private.test' ? ['127.0.0.1', '10.0.0.1'] : host.endsWith('.test') ? ['127.0.0.1'] : ['127.0.0.9']),
    addressAllowed: (ip) => ip === '127.0.0.1',
  };
}

const html = (body: string, title = 'page') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

export async function startFixture(): Promise<Fixture> {
  const fixture = { google: 'ok' } as Fixture;
  fixture.hits = [];
  let port = 0;
  const at = (host: string, path = '/') => `http://${host}:${port}${path}`;
  const server: Server = createServer(async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    const path = req.url ?? '/';
    const body = await readBody(req);
    fixture.hits.push({ host, method: req.method ?? 'GET', path, body });
    const send = (status: number, text: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': type, ...extra }).end(text);
    const route = `${host}${path.split('?')[0]}`;

    if (host === 'evil.test') return send(200, html('<h1>evil</h1>'));
    if (host === 'cdn.test') return send(200, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', 'image/svg+xml');
    switch (route) {
      case 'shop.test/':
        return send(
          200,
          html(
            `<h1>Shop</h1><img src="${at('cdn.test', '/logo.svg')}" alt="logo">
            <form action="/buy" method="post"><label>Name <input name="name"></label>
              <label>Size <select name="size"><option>S</option><option>M</option></select></label>
              <input type="hidden" name="csrf" value="t0k3n">
              <button type="submit">Buy now</button></form>
            <a href="/about">About</a>
            <a href="${at('evil.test', '/x?leak=1')}">Evil link</a>
            <a href="${at('evil.test', '/popup')}" target="_blank">Evil popup</a>
            <a href="/redir-evil">Redirect link</a>
            <a href="/meta-evil">Meta link</a>
            <button id="js-nav" onclick="location.href='${at('evil.test', '/js?leak=1')}'">Go</button>
            <button id="js-post" onclick="document.getElementById('hidden-form').submit()">Save</button>
            <form id="hidden-form" action="/buy" method="post"><input type="hidden" name="secret" value="from-page"></form>
            <iframe src="${at('evil.test', '/frame')}"></iframe>`,
            'Shop',
          ),
        );
      case 'shop.test/about':
        return send(200, html('<h1>About the shop</h1><p>We sell shirts.</p>', 'About'));
      case 'shop.test/buy':
        return send(200, html(`<h1>Order placed</h1><p>${req.method} ${body}</p>`, 'Done'));
      case 'shop.test/redir-evil':
        return send(302, '', 'text/plain', { location: at('evil.test', '/redirected?leak=1') });
      case 'shop.test/meta-evil':
        return send(200, html(`<meta http-equiv="refresh" content="0;url=${at('evil.test', '/meta?leak=1')}"><p>moving</p>`));
      case 'shop.test/redir-private':
        return send(302, '', 'text/plain', { location: `http://127.0.0.2:${port}/admin` });
      case 'shop.test/hang':
        return send(200, html('<h1>hang</h1><script>setTimeout(() => { for (;;) {} }, 100)</script>', 'Hang'));
      case 'shop.test/article':
        return send(
          200,
          html(
            `<nav><a href="/">Home</a> <a href="/about">About</a></nav><article><h1>Shirts in autumn</h1>
            ${'<p>Cotton shirts keep warm when the days get shorter. Wool is better for the coldest weeks of the year. </p>'.repeat(12)}
            <p>Read <a href="/about">about us</a>.</p></article><footer>footer text</footer>`,
            'Shirts in autumn',
          ),
        );
      case 'shop.test/latin1':
        return res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      case 'shop.test/pdf':
        return send(200, '%PDF-1.4 '.repeat(1000), 'application/pdf');
      case 'shop.test/bomb':
        // 50 mb of zeros, about 50 kb on the wire.
        return res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end(gzipSync(Buffer.alloc(50_000_000)));
      case 'shop.test/slow':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first part');
        return; // the rest never comes.
      case 'shop.test/loop':
        return send(302, '', 'text/plain', { location: '/loop' });
      case 'shop.test/deep':
        return send(200, html(`${'<div>'.repeat(60_000)}deep text${'</div>'.repeat(60_000)}`));
      case 'shop.test/many':
        return send(200, html(`${'<p>row</p>'.repeat(50_000)}<p>the end</p>`));
      case 'www.google.test/search': {
        if (fixture.google === 'captcha') return send(302, '', 'text/plain', { location: at('www.google.test', '/sorry/index?continue=x') });
        if (fixture.google === 'consent') return send(302, '', 'text/plain', { location: at('consent.google.test', '/ml?continue=x') });
        if (fixture.google === 'layout') return send(200, html('<div id="main"><span>results moved</span><a href="/x">x</a></div>'));
        const q = new URL(path, 'http://x').searchParams.get('q') ?? '';
        return send(
          200,
          html(
            `<div id="search"><div class="g"><a href="/url?q=${encodeURIComponent('https://shirts.example/autumn')}&sa=U"><h3>Autumn shirts for ${q}</h3></a>
             <div class="VwiC3b">Cotton and wool shirts.</div></div>
             <div class="g"><a href="https://wiki.example/Shirt"><h3>Shirt - Wiki</h3></a><div class="VwiC3b">A shirt is a cloth garment.</div></div></div>`,
            `${q} - Google Search`,
          ),
        );
      }
      case 'www.google.test/sorry/index':
        return send(429, html('<p>Our systems have detected unusual traffic from your computer network.</p><form id="captcha-form"></form>'));
      case 'consent.google.test/ml':
        return send(200, html('<form action="https://consent.google.test/save"><button>Reject all</button><button>Accept all</button></form>'));
      case 'html.duckduckgo.test/html/': {
        const q = new URL(path, 'http://x').searchParams.get('q') ?? '';
        return send(
          200,
          html(
            `<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://shirts.example/ddg')}&rut=1">Shirts on DDG for ${q}</a></h2>
             <a class="result__snippet">Plain shirts.</a></div>`,
          ),
        );
      }
      default:
        return send(404, html('<h1>not found</h1>'));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  fixture.port = port;
  fixture.url = at;
  fixture.hitsOn = (host) => fixture.hits.filter((hit) => hit.host === host);
  fixture.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fixture;
}
