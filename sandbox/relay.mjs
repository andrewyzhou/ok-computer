// the relay of a sandbox call with network access (src/sandbox/network.ts). it runs in its own container, which is on
// the internal network of the call and on a normal bridge network. the code container has no route out, so it can
// reach only this relay, and the relay pipes each connection to the egress proxy of the app and to no other address.
// the proxy checks the allowlist of the call and the address of each host.
//
// usage: node /opt/okc/relay.mjs <proxy host> <proxy port> <ready name>
//
// the relay tells the app that it listens with a tunnel request for the ready name. the proxy refuses it, and the app
// then starts the code container.
import { connect, createServer } from 'node:net';

const [host, portText, ready] = process.argv.slice(2);
const port = Number(portText);
if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !ready) {
  process.stderr.write('usage: node relay.mjs <proxy host> <proxy port> <ready name>\n');
  process.exit(2);
}

// the code of a call can open many connections, so the relay keeps a limit.
const MAX_CONNECTIONS = 64;
let open = 0;

const server = createServer((client) => {
  if (open >= MAX_CONNECTIONS) return void client.destroy();
  open += 1;
  const upstream = connect(port, host);
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.once('close', () => {
    open -= 1;
    upstream.destroy();
  });
  client.on('error', end);
  upstream.on('error', end);
  upstream.on('close', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

// the name of the proxy can need a moment to resolve after the start, so the signal tries again for a short time.
function signalReady(left) {
  let failed = false;
  const socket = connect(port, host, () => socket.write(`CONNECT ${ready}:1 HTTP/1.1\r\nHost: ${ready}:1\r\n\r\n`));
  socket.setTimeout(2_000, () => socket.destroy(new Error('no answer')));
  socket.once('data', () => socket.destroy());
  socket.on('error', (err) => {
    if (failed) return;
    failed = true;
    if (left > 0) setTimeout(() => signalReady(left - 1), 200);
    else process.stderr.write(`the relay cannot reach the proxy at ${host}:${port}: ${err.message}\n`);
  });
}

// the container has only the two networks of the call, so 0.0.0.0 here is the internal network and the bridge.
server.listen(3128, '0.0.0.0', () => signalReady(25));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
