import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../observability/logger.js';
import { publicEgress, type Egress } from '../web/egress.js';
import { createDockerClient, endpointOf } from './docker.js';
import { LABELS, SANDBOX_IMAGE, SANDBOX_USER } from './limits.js';
import { checkAllowlist, createNetworkGate, networkName, proxyPathFor, relayName, RELAY_PORT, RELAY_SCRIPT, sweepNetworks } from './network.js';
import type { ContainerSpec, DockerClient } from './types.js';

const logger = createLogger({ consoleLevel: 'off' });
// as in test/web-fixture.ts: every .test name is the loopback fixture, and only that address is allowed.
const egress: Egress = {
  resolve: async (host) => (host.endsWith('.test') ? ['127.0.0.1'] : ['127.0.0.9']),
  addressAllowed: (ip) => ip === '127.0.0.1',
};

type Body = ContainerSpec & { NetworkingConfig: { EndpointsConfig: Record<string, { Aliases?: string[] }> } };

// a fake engine that records each call. start plays the relay: it sends the ready request to the proxy of the call,
// as sandbox/relay.mjs does.
function fakeDocker(options: { failAt?: string; relayStarts?: boolean; engine?: string } = {}) {
  const calls: string[] = [];
  const networks = new Map<string, { internal: boolean; labels: Record<string, string> }>();
  const containers = new Map<string, Body>();
  const fail = (step: string) => {
    if (options.failAt === step) throw new Error(`${step} failed`);
  };
  const docker = {
    info: async () => {
      calls.push('info');
      return { engine: options.engine ?? 'docker 28.3.0 (linux/arm64)', os: 'linux', arch: 'arm64' };
    },
    createNetwork: async (name: string, opts: { internal: boolean; labels: Record<string, string> }) => {
      calls.push(`createNetwork ${name}`);
      fail('createNetwork');
      networks.set(name, opts);
      return `id-${name}`;
    },
    removeNetwork: async (name: string) => {
      calls.push(`removeNetwork ${name}`);
      fail('removeNetwork');
      networks.delete(name);
    },
    createContainer: async (name: string, spec: ContainerSpec) => {
      calls.push(`createContainer ${name}`);
      containers.set(name, spec as Body);
      fail('createContainer');
      return name;
    },
    start: async (id: string) => {
      calls.push(`start ${id}`);
      fail('start');
      if (options.relayStarts === false) return;
      const [, , , port, ready] = containers.get(id)!.Cmd;
      const socket = connect(Number(port), '127.0.0.1', () => socket.write(`CONNECT ${ready}:1 HTTP/1.1\r\n\r\n`));
      socket.once('data', () => socket.destroy());
      socket.on('error', () => undefined);
    },
    removeContainer: async (id: string) => {
      calls.push(`removeContainer ${id}`);
      containers.delete(id);
    },
  };
  return { docker: docker as unknown as DockerClient, calls, networks, containers };
}

const host = { platform: 'darwin' as const, inContainer: false, interfaces: {} };
const gateWith = (fake: ReturnType<typeof fakeDocker>, extra: Partial<Parameters<typeof createNetworkGate>[0]> = {}) =>
  createNetworkGate({ docker: fake.docker, egress, logger, instance: 'inst', ...host, ...extra });

describe('checkAllowlist', () => {
  it('accepts sites and their subdomains, in any case and with a trailing dot', () => {
    expect(checkAllowlist(['pypi.org', 'Files.PythonHosted.org.', 'www.example.co.uk'])).toBeUndefined();
  });
  it.each([
    [['1.2.3.4'], 'use a host name, not an address'],
    [['[::1]'], 'use a host name, not an address'],
    [['::1'], 'use a host name, not an address'],
    [['1.2.3'], 'use a host name, not an address'],
    [['com'], 'com is too broad. Name the site, for example pypi.org'],
    [['co.uk'], 'co.uk is too broad. Name the site, for example pypi.org'],
    [['pypi.org', 'org.'], 'org is too broad. Name the site, for example pypi.org'],
    [['https://pypi.org'], /is not a host name/],
    [['pypi.org:443'], /is not a host name/],
    [['-bad.org'], /is not a host name/],
    [['a..b.org'], /is not a host name/],
    [[], /at least one host/],
  ])('refuses %j', (list, reason) => {
    if (typeof reason === 'string') expect(checkAllowlist(list)).toBe(reason);
    else expect(checkAllowlist(list)).toMatch(reason);
  });
});

describe('proxyPathFor', () => {
  it('keeps the proxy on loopback with docker desktop', () => {
    expect(proxyPathFor(host)).toEqual({ ok: true, listen: '127.0.0.1', proxyHost: 'host.docker.internal', extraHosts: [] });
    expect(proxyPathFor({ ...host, platform: 'win32' })).toMatchObject({ ok: true, listen: '127.0.0.1' });
  });
  it('binds the proxy to the docker0 bridge on linux, never to every address', () => {
    const interfaces = { docker0: [{ address: '172.17.0.1', family: 'IPv4' as const, netmask: '255.255.0.0', mac: '', internal: false, cidr: null }] };
    expect(proxyPathFor({ platform: 'linux', inContainer: false, interfaces })).toEqual({ ok: true, listen: '172.17.0.1', proxyHost: '172.17.0.1', extraHosts: [] });
    expect(proxyPathFor({ platform: 'linux', inContainer: false, interfaces: {} })).toMatchObject({ ok: false, reason: /docker0/ });
  });
  it('says why it cannot work when the app runs in a container or on another system', () => {
    expect(proxyPathFor({ ...host, inContainer: true })).toMatchObject({ ok: false, reason: /runs in a container/ });
    expect(proxyPathFor({ ...host, platform: 'freebsd' })).toMatchObject({ ok: false, reason: /freebsd/ });
  });
});

describe('check', () => {
  it('probes once with a labelled internal network and keeps the answer', async () => {
    const fake = fakeDocker();
    const gate = gateWith(fake);
    expect(await gate.check()).toEqual({ ok: true });
    expect(await gate.check()).toEqual({ ok: true });
    expect(fake.calls.filter((call) => call === 'info')).toHaveLength(1);
    const made = fake.calls.filter((call) => call.startsWith('createNetwork'));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(/^createNetwork okc-net-inst-probe-[0-9a-f]+$/);
    expect(fake.calls).toContain(made[0]!.replace('createNetwork', 'removeNetwork'));
    expect(fake.networks.size).toBe(0);
  });
  it('says no on an old engine, in a container, and when docker cannot make the network', async () => {
    expect(await gateWith(fakeDocker({ engine: 'docker 25.0.3 (linux/amd64)' })).check()).toMatchObject({ ok: false, reason: /docker 26 or later/ });
    expect(await gateWith(fakeDocker(), { inContainer: true }).check()).toMatchObject({ ok: false, reason: /runs in a container/ });
    expect(await gateWith(fakeDocker({ failAt: 'createNetwork' })).check()).toMatchObject({ ok: false, reason: /cannot make an internal network/ });
  });
  it('asks again after the engine did not answer', async () => {
    const fake = fakeDocker();
    let down = true;
    const info = fake.docker.info;
    fake.docker.info = async (signal) => {
      if (down) throw new Error('connect ENOENT');
      return info(signal);
    };
    const gate = gateWith(fake);
    expect(await gate.check()).toMatchObject({ ok: false, reason: /does not answer/ });
    down = false;
    expect(await gate.check()).toEqual({ ok: true });
  });
  it('asks again after docker could not make the probe network, and keeps a fixed reason', async () => {
    const fake = fakeDocker();
    let broken = true;
    const create = fake.docker.createNetwork;
    fake.docker.createNetwork = async (...args) => {
      if (broken) throw new Error('the probe network was removed');
      return create(...args);
    };
    const gate = gateWith(fake);
    expect(await gate.check()).toMatchObject({ ok: false, reason: /cannot make an internal network/ });
    broken = false;
    expect(await gate.check()).toEqual({ ok: true });
    const old = fakeDocker({ engine: 'docker 25.0.3 (linux/amd64)' });
    const oldGate = gateWith(old);
    await oldGate.check();
    await oldGate.check();
    expect(old.calls.filter((call) => call === 'info')).toHaveLength(1);
  });

  it('makes open fail with the reason and leaves nothing behind', async () => {
    const fake = fakeDocker();
    await expect(gateWith(fake, { inContainer: true }).open(1, ['pypi.org'])).rejects.toThrow(/runs in a container/);
    expect(fake.calls).toEqual([]);
  });
});

describe('open and close', () => {
  const labels = { [LABELS.sandbox]: '1', [LABELS.instance]: 'inst', [LABELS.exec]: '7' };

  it('makes a labelled internal network, a hardened relay on it and the proxy variables', async () => {
    const fake = fakeDocker();
    const plan = await gateWith(fake).open(7, ['pypi.org']);
    const network = networkName('inst', 7);
    const relay = relayName('inst', 7);
    expect(plan.networkMode).toBe(network);
    expect(fake.networks.get(network)).toEqual({ internal: true, labels });
    const proxy = plan.env[0]!.slice('HTTP_PROXY='.length);
    expect(proxy).toMatch(new RegExp(`^http://okc:[0-9a-f]{48}@${relay}:${RELAY_PORT}$`));
    expect(plan.env).toEqual([`HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, `http_proxy=${proxy}`, `https_proxy=${proxy}`, 'NO_PROXY=', 'no_proxy=', 'NODE_USE_ENV_PROXY=1']);
    expect(plan.extraHosts).toEqual([]);

    const body = fake.containers.get(relay)!;
    expect(body.Image).toBe(SANDBOX_IMAGE);
    expect(body.Labels).toEqual(labels);
    expect(body.User).toBe(SANDBOX_USER);
    expect(body.Cmd.slice(0, 3)).toEqual(['node', RELAY_SCRIPT, 'host.docker.internal']);
    expect(body.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, NetworkMode: 'bridge' });
    expect(body.HostConfig.Memory).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(body.HostConfig.MemorySwap).toBe(body.HostConfig.Memory);
    expect(body.HostConfig.PidsLimit).toBeLessThanOrEqual(32);
    expect(body.NetworkingConfig.EndpointsConfig).toEqual({ bridge: {}, [network]: { Aliases: [relay] } });

    // the ready signal of the relay is not a refusal of the call.
    expect(plan.refused()).toEqual([]);
    await plan.close();
    await plan.close();
    expect(fake.networks.size).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.calls.filter((call) => call === `removeNetwork ${network}`)).toHaveLength(1);
    expect(fake.calls.indexOf(`removeContainer ${relay}`)).toBeLessThan(fake.calls.indexOf(`removeNetwork ${network}`));
  });

  it('refuses a bad allowlist before it makes anything', async () => {
    const fake = fakeDocker();
    await expect(gateWith(fake).open(7, ['com'])).rejects.toThrow('com is too broad');
    expect(fake.calls.some((call) => call.startsWith('createNetwork okc-net-inst-7'))).toBe(false);
  });

  it.each(['createContainer', 'start'])('removes everything when %s fails', async (step) => {
    const fake = fakeDocker({ failAt: step });
    await expect(gateWith(fake).open(7, ['pypi.org'])).rejects.toThrow(`${step} failed`);
    expect(fake.networks.size).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.calls).toContain(`removeContainer ${relayName('inst', 7)}`);
  });

  it('removes everything when the relay does not report', async () => {
    const fake = fakeDocker({ relayStarts: false });
    await expect(gateWith(fake, { readyMs: 200 }).open(7, ['pypi.org'])).rejects.toThrow(/did not reach the proxy/);
    expect(fake.networks.size).toBe(0);
    expect(fake.containers.size).toBe(0);
  });

  it('logs a failed cleanup and does not throw', async () => {
    const fake = fakeDocker();
    const plan = await gateWith(fake).open(7, ['pypi.org']);
    fake.docker.removeNetwork = async () => {
      throw new Error('network in use');
    };
    await expect(plan.close()).resolves.toBeUndefined();
  });
});

describe('the proxy of a call', () => {
  let site: Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    site = createServer((req, res) => {
      hits.push(req.headers.host ?? '');
      if (req.headers['proxy-authorization'] !== undefined) hits.push('the credential reached the host');
      res.end('ok');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    port = (site.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())));

  // the code container sends the credential that its proxy variables name, as curl and pip do.
  const credentialOf = (plan: { env: string[] }) => {
    const url = new URL(plan.env[0]!.slice('HTTP_PROXY='.length));
    return `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
  };
  let credential: string | undefined;
  const through = (proxyPort: string, target: string, auth: string | null = credential ?? null) =>
    new Promise<number>((resolve, reject) => {
      const headers = { host: new URL(target).host, ...(auth !== null ? { 'proxy-authorization': auth } : {}) };
      request({ host: '127.0.0.1', port: proxyPort, path: target, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });

  it('passes an allowed subdomain, refuses a host off the list, and records both', async () => {
    const fake = fakeDocker();
    const plan = await gateWith(fake).open(9, ['shop.test']);
    const proxyPort = fake.containers.get(relayName('inst', 9))!.Cmd[3]!;
    credential = credentialOf(plan);
    try {
      expect(await through(proxyPort, `http://api.shop.test:${port}/`)).toBe(200);
      expect(await through(proxyPort, `http://evil.test:${port}/`)).toBe(403);
      // a name that only starts like an allowed site is not a subdomain of it.
      expect(await through(proxyPort, `http://shop.test.example:${port}/`)).toBe(403);
      expect(hits).toEqual([`api.shop.test:${port}`]);
      expect(plan.passed()).toEqual(['api.shop.test']);
      expect(plan.refused()).toEqual([
        { target: `http://evil.test:${port}/`, reason: 'evil.test is not in the allowlist of this call' },
        { target: `http://shop.test.example:${port}/`, reason: 'shop.test.example is not in the allowlist of this call' },
      ]);
    } finally {
      await plan.close();
    }
    await expect(through(proxyPort, `http://api.shop.test:${port}/`)).rejects.toThrow();
  });

  it('refuses a request without the credential of the call', async () => {
    const fake = fakeDocker();
    const plan = await gateWith(fake).open(12, ['shop.test']);
    const proxyPort = fake.containers.get(relayName('inst', 12))!.Cmd[3]!;
    const other = await gateWith(fakeDocker()).open(13, ['shop.test']);
    try {
      expect(await through(proxyPort, `http://api.shop.test:${port}/`, null)).toBe(407);
      expect(await through(proxyPort, `http://api.shop.test:${port}/`, 'Basic b2tjOndyb25n')).toBe(407);
      // the credential of another call does not open this one.
      expect(await through(proxyPort, `http://api.shop.test:${port}/`, credentialOf(other))).toBe(407);
      expect(plan.passed()).toEqual([]);
      expect(plan.refused()).toHaveLength(3);
      expect(plan.refused()[0]?.reason).toMatch(/no valid credential/);
    } finally {
      await plan.close();
      await other.close();
    }
  });

  it('refuses an allowed host whose address is private', async () => {
    const fake = fakeDocker();
    const plan = await gateWith(fake).open(10, ['owner.example']);
    const proxyPort = fake.containers.get(relayName('inst', 10))!.Cmd[3]!;
    credential = credentialOf(plan);
    try {
      expect(await through(proxyPort, `http://owner.example:${port}/`)).toBe(403);
      expect(plan.refused()[0]?.reason).toMatch(/points to 127\.0\.0\.9/);
    } finally {
      await plan.close();
    }
  });

  it('lets through the host of an entry that starts with www', async () => {
    const fake = fakeDocker();
    const plan = await gateWith(fake).open(11, ['www.shop.test']);
    const proxyPort = fake.containers.get(relayName('inst', 11))!.Cmd[3]!;
    credential = credentialOf(plan);
    try {
      expect(await through(proxyPort, `http://www.shop.test:${port}/`)).toBe(200);
      expect(plan.refused()).toEqual([]);
    } finally {
      await plan.close();
    }
  });
});

describe('sweepNetworks', () => {
  it('removes the labelled networks of this instance whose exec does not run', async () => {
    const removed: string[] = [];
    const docker = {
      listNetworks: async (): Promise<Array<{ name: string; labels: Record<string, string> }>> => [
        { name: 'a', labels: { [LABELS.sandbox]: '1', [LABELS.instance]: 'inst', [LABELS.exec]: '1' } },
        { name: 'b', labels: { [LABELS.sandbox]: '1', [LABELS.instance]: 'inst', [LABELS.exec]: '2' } },
        { name: 'probe', labels: { [LABELS.sandbox]: '1', [LABELS.instance]: 'inst', [LABELS.exec]: 'probe' } },
        { name: 'other', labels: { [LABELS.sandbox]: '1', [LABELS.instance]: 'other', [LABELS.exec]: '3' } },
        { name: 'foreign', labels: {} },
      ],
      removeNetwork: async (name: string) => void removed.push(name),
    };
    expect(await sweepNetworks(docker, 'inst', (execId) => execId === 2)).toBe(2);
    expect(removed).toEqual(['a', 'probe']);
  });
});

// the proof of isolation. it runs only when a docker daemon answers and the image is built (npm run sandbox:image).
async function realDocker(): Promise<DockerClient | undefined> {
  try {
    const found = endpointOf(process.env, process.platform, homedir(), existsSync);
    if ('error' in found) return undefined;
    const docker = createDockerClient(found);
    const signal = AbortSignal.timeout(2_000);
    await docker.info(signal);
    return (await docker.imageId(SANDBOX_IMAGE, signal)) ? docker : undefined;
  } catch {
    return undefined;
  }
}
const docker = await realDocker();
const dockerReady = docker !== undefined;
const online = await lookup('example.com').then(
  () => true,
  () => false,
);

// the probe prints one json line. each check gives a short text, so a failure shows what the container saw.
const PROBE = String.raw`
import json, socket, urllib.request, urllib.error
def fetch(url):
    try:
        return str(urllib.request.urlopen(url, timeout=15).status)
    except urllib.error.HTTPError as e:
        return str(e.code)
    except Exception as e:
        return 'error ' + str(e)
def tcp(host, port):
    try:
        socket.create_connection((host, port), timeout=3).close()
        return 'connected'
    except Exception as e:
        return 'error ' + str(e)
def dns(name):
    try:
        return 'resolved ' + socket.getaddrinfo(name, 443)[0][4][0]
    except Exception as e:
        return 'error ' + str(e)
def udp_dns(server):
    query = b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01'
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        s.sendto(query, (server, 53))
        s.recvfrom(512)
        return 'answered'
    except Exception as e:
        return 'error ' + str(e)
print(json.dumps({
    'allowed': fetch('https://example.com/'),
    'offList': fetch('http://example.org/'),
    'offListTls': fetch('https://example.org/'),
    'direct': tcp('1.1.1.1', 443),
    'hostDirect': tcp('host.docker.internal', 80),
    'dns': dns('example.com'),
    'udpDns': udp_dns('8.8.8.8'),
}))
`;

describe.skipIf(!dockerReady)('the network of a call on a real docker host', { timeout: 120_000 }, () => {
  it('reaches only the allowed host through the proxy, and has no other way out', async () => {
    const real = docker!;
    const gate = createNetworkGate({ docker: real, egress: publicEgress, logger, instance: `test${process.pid}` });
    const ready = await gate.check();
    expect(ready).toEqual({ ok: true });
    const execId = Date.now() % 1_000_000;
    const plan = await gate.open(execId, ['example.com']);
    const name = `okc-sandbox-test${process.pid}-${execId}`;
    try {
      const memory = 256 * 1024 * 1024;
      const spec: ContainerSpec = {
        Image: SANDBOX_IMAGE,
        Entrypoint: [''],
        Cmd: ['python3', '-c', PROBE],
        Env: plan.env,
        WorkingDir: '/tmp',
        User: SANDBOX_USER,
        Labels: { [LABELS.sandbox]: '1', [LABELS.instance]: `test${process.pid}`, [LABELS.exec]: String(execId) },
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: false,
        OpenStdin: false,
        NetworkDisabled: false,
        HostConfig: {
          NetworkMode: plan.networkMode,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Privileged: false,
          NanoCpus: 1e9,
          Memory: memory,
          MemorySwap: memory,
          PidsLimit: 64,
          Ulimits: [],
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
          Mounts: [],
          ExtraHosts: plan.extraHosts,
          Init: true,
          AutoRemove: false,
        },
      };
      const id = await real.createContainer(name, spec);
      const attached = await real.attach(id);
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      attached.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      attached.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
      await real.start(id);
      const code = await real.wait(id);
      attached.close();
      expect(code, Buffer.concat(errors).toString()).toBe(0);
      const seen = JSON.parse(Buffer.concat(chunks).toString().trim()) as Record<string, string>;
      if (online) expect(seen.allowed).toBe('200');
      expect(seen.offList).toBe('403');
      expect(seen.offListTls).toMatch(/403/);
      expect(seen.direct).toMatch(/^error/);
      expect(seen.hostDirect).toMatch(/^error/);
      expect(seen.dns).toMatch(/^error/);
      expect(seen.udpDns).toMatch(/^error/);
      expect(plan.refused().map((each) => each.target)).toEqual(expect.arrayContaining(['http://example.org/', 'example.org:443']));
    } finally {
      await real.removeContainer(name);
      await plan.close();
    }
  });
});

describe('sweepNetworks and the probes of another process', () => {
  it('keeps a probe network younger than a minute and removes an old one', async () => {
    const removed: string[] = [];
    const now = Date.parse('2026-10-18T10:00:00Z');
    const probe = { [LABELS.sandbox]: '1', [LABELS.instance]: 'inst', [LABELS.exec]: 'probe' };
    const docker = {
      listNetworks: async () => [
        { name: 'young', labels: probe, createdAt: new Date(now - 5_000).toISOString() },
        { name: 'old', labels: probe, createdAt: new Date(now - 120_000).toISOString() },
      ],
      removeNetwork: async (name: string) => void removed.push(name),
    };
    expect(await sweepNetworks(docker, 'inst', () => false, { now })).toBe(1);
    expect(removed).toEqual(['old']);
  });
});
