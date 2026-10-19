import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { allowedBy, siteOf, tooBroad } from '../browser/gate.js';
import { startEgressProxy, type EgressProxy } from '../browser/proxy.js';
import type { Logger } from '../observability/logger.js';
import { errorText } from '../tools/registry.js';
import type { Egress } from '../web/egress.js';
import { LABELS, SANDBOX_IMAGE, SANDBOX_USER } from './limits.js';
import type { ContainerSpec, DockerClient, NetworkGate, NetworkPlan } from './types.js';

// a call with network access reaches the internet only through the egress proxy of the app (src/browser/proxy.ts),
// with the hosts of its allowlist. the container has no other route out: a direct connection to any address fails.
// when this host cannot give that, check() says why, and a call with an allowlist fails while a call without one works.
//
// the design: each call gets its own internal docker network, which has no route out of the host, and its own proxy
// with the allowlist of the call. the proxy runs in the app, so it checks each address as the browser proxy does, and a
// name that resolves to a private address does not get through. the internal network cannot reach the app, so a
// second small container, the relay (sandbox/relay.mjs), sits on the internal network and on a normal bridge network.
// it pipes each connection to the proxy of the call and to no other address. the code container gets the relay as its
// HTTP_PROXY and HTTPS_PROXY. a direct connection, a udp packet or a dns query to an outside server finds no route.

// the relay listens on this port in its container.
export const RELAY_PORT = 3128;
// the image definition copies sandbox/relay.mjs to this path.
export const RELAY_SCRIPT = '/opt/okc/relay.mjs';
// the relay must tell the app that it listens within this time, or the call fails.
export const RELAY_READY_MS = 15_000;
// an older engine forwards the dns queries of an internal network to the outside resolver, so a call could send data
// out in dns names.
export const MIN_ENGINE_MAJOR = 26;

export const networkName = (instance: string, execId: number) => `okc-net-${instance}-${execId}`;
export const relayName = (instance: string, execId: number) => `okc-relay-${instance}-${execId}`;

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const normalized = (entry: string) => entry.toLowerCase().replace(/\.$/, '');

// checkAllowlist gives the reason when an entry is too broad (a public suffix such as com or co.uk, see tooBroad in
// src/browser/gate.ts) or not a host name. it gives undefined for a good list.
export function checkAllowlist(allowlist: readonly string[]): string | undefined {
  if (!allowlist.length) return 'name at least one host, for example pypi.org';
  for (const raw of allowlist) {
    const entry = normalized(raw);
    // a name whose last label is a number is read as an ipv4 address by a url parser, for example 1.2.3.
    if (isIP(entry.replace(/^\[|\]$/g, '')) || /(?:^|\.)\d+$/.test(entry)) return 'use a host name, not an address';
    if (!HOST_NAME.test(entry)) return `${JSON.stringify(raw)} is not a host name. Use a name such as pypi.org, without a scheme, a port or a path`;
    if (tooBroad(siteOf(entry))) return `${entry} is too broad. Name the site, for example pypi.org`;
  }
  return undefined;
}

// the way from the relay to the proxy of the app.
export type ProxyPath =
  | {
      ok: true;
      // the address that the proxy of a call listens on.
      listen: string;
      // the host that the relay connects to.
      proxyHost: string;
      // ExtraHosts of the relay container.
      extraHosts: string[];
    }
  | { ok: false; reason: string };

// proxyPathFor finds the way from a container to a service of the app. it is a pure function of the host, so a test
// can give each case.
export function proxyPathFor(host: {
  platform: NodeJS.Platform;
  inContainer: boolean;
  interfaces: ReturnType<typeof networkInterfaces>;
}): ProxyPath {
  // the app in a container (phase 5 m7) talks to the docker of its host, so a sandbox container cannot reach a proxy
  // inside the app container.
  if (host.inContainer) {
    return { ok: false, reason: 'the app runs in a container, so a sandbox container cannot reach its egress proxy. Calls without network access still work' };
  }
  // docker desktop forwards host.docker.internal to the loopback address of this pc, so the proxy stays on loopback.
  if (host.platform === 'darwin' || host.platform === 'win32') return { ok: true, listen: '127.0.0.1', proxyHost: 'host.docker.internal', extraHosts: [] };
  if (host.platform === 'linux') {
    // the linux engine reaches the host at the address of the docker0 bridge. the proxy listens only there, never on
    // every address, so the local network does not reach it.
    const bridge = host.interfaces.docker0?.find((each) => each.family === 'IPv4')?.address;
    if (!bridge) return { ok: false, reason: 'the docker0 bridge was not found on this host, so a sandbox container cannot reach the egress proxy' };
    return { ok: true, listen: bridge, proxyHost: bridge, extraHosts: [] };
  }
  return { ok: false, reason: `a call with network access needs docker desktop or the linux engine, not ${host.platform}` };
}

export interface NetworkGateDeps {
  docker: DockerClient;
  egress: Egress;
  logger: Logger;
  instance: string;
  // the image of the relay. it is the image of the code, which holds the relay script.
  image?: string;
  // tests give the host. the app reads it from the process.
  platform?: NodeJS.Platform;
  inContainer?: boolean;
  interfaces?: ReturnType<typeof networkInterfaces>;
  readyMs?: number;
}

export function createNetworkGate(deps: NetworkGateDeps): NetworkGate {
  const { docker, egress, logger, instance } = deps;
  const image = deps.image ?? SANDBOX_IMAGE;
  const readyMs = deps.readyMs ?? RELAY_READY_MS;
  const path = () =>
    proxyPathFor({
      platform: deps.platform ?? process.platform,
      inContainer: deps.inContainer ?? existsSync('/.dockerenv'),
      interfaces: deps.interfaces ?? networkInterfaces(),
    });
  const labels = (exec: string) => ({ [LABELS.sandbox]: '1', [LABELS.instance]: instance, [LABELS.exec]: exec });

  // the answer holds for the life of the process. only an engine that does not answer is asked again.
  let checked: Promise<{ ok: true } | { ok: false; reason: string }> | undefined;
  async function probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const found = path();
    if (!found.ok) return found;
    const info = await docker.info(AbortSignal.timeout(3_000));
    const major = Number(/(\d+)\.\d+/.exec(info.engine)?.[1]);
    if (Number.isInteger(major) && major < MIN_ENGINE_MAJOR) {
      return { ok: false, reason: `a call with network access needs docker ${MIN_ENGINE_MAJOR} or later, because an older engine lets an internal network ask an outside dns server` };
    }
    // npm run chat and the service share the instance, so each probe has its own name. sweepNetworks removes the probe
    // network of a process that stopped.
    const name = `okc-net-${instance}-probe-${randomBytes(4).toString('hex')}`;
    try {
      await docker.createNetwork(name, { internal: true, labels: labels('probe') });
      await docker.removeNetwork(name);
    } catch (err) {
      return { ok: false, reason: `docker cannot make an internal network: ${errorText(err)}` };
    }
    return { ok: true };
  }
  function check() {
    checked ??= probe().catch((err: unknown) => {
      checked = undefined;
      return { ok: false as const, reason: `docker does not answer: ${errorText(err)}` };
    });
    return checked;
  }

  async function open(execId: number, allowlist: string[]): Promise<NetworkPlan> {
    const checkedNow = await check();
    if (!checkedNow.ok) throw new Error(checkedNow.reason);
    const found = path();
    if (!found.ok) throw new Error(found.reason);
    const bad = checkAllowlist(allowlist);
    if (bad) throw new Error(bad);
    const list = allowlist.map(normalized);
    const network = networkName(instance, execId);
    const relay = relayName(instance, execId);
    // the relay sends a tunnel request for this name when it listens. the name is new for each call and ends in
    // .invalid, so it is never a real host.
    const readyHost = `ready-${randomBytes(8).toString('hex')}.okc.invalid`;
    const passed = new Set<string>();
    const refused: Array<{ target: string; reason: string }> = [];
    let signalReady = () => undefined as void;
    const ready = new Promise<void>((resolve) => (signalReady = resolve));

    const made = { network: false, proxy: undefined as EgressProxy | undefined, relay: false };
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        const step = async (what: string, run: () => Promise<void>) => {
          try {
            await run();
          } catch (err) {
            logger.warn('sandbox network cleanup failed', { execId, step: what, err });
          }
        };
        // the proxy stops first, so nothing gets out while the rest goes away.
        if (made.proxy) await step('proxy', made.proxy.close);
        // a network with a container on it cannot be removed, so the relay goes first.
        if (made.relay) await step('relay', () => docker.removeContainer(relay));
        if (made.network) await step('network', () => docker.removeNetwork(network));
      })());

    try {
      await docker.createNetwork(network, { internal: true, labels: labels(String(execId)) });
      made.network = true;
      made.proxy = await startEgressProxy(
        egress,
        (target, reason) => {
          if (!target.startsWith(`${readyHost}:`)) refused.push({ target, reason });
        },
        (host) => passed.add(host),
        {
          allowHost: (host) => {
            if (host === readyHost) {
              signalReady();
              return 'the ready signal of the relay';
            }
            return allowedBy(list, host) ? undefined : `${host} is not in the allowlist of this call`;
          },
          listen: found.listen,
        },
      );
      const port = new URL(made.proxy.url).port;
      // the engine may make the container and still answer with an error, so the cleanup removes it by name.
      made.relay = true;
      const id = await docker.createContainer(relay, relayBody({ image, labels: labels(String(execId)), network, relay, proxyHost: found.proxyHost, port, readyHost, extraHosts: found.extraHosts }));
      await docker.start(id);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the network relay did not reach the proxy within ${readyMs / 1000} s`)), readyMs);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (err) {
      await close();
      throw err;
    }

    const proxyUrl = `http://${relay}:${RELAY_PORT}`;
    return {
      networkMode: network,
      env: [
        `HTTP_PROXY=${proxyUrl}`,
        `HTTPS_PROXY=${proxyUrl}`,
        `http_proxy=${proxyUrl}`,
        `https_proxy=${proxyUrl}`,
        'NO_PROXY=',
        'no_proxy=',
        // node reads the proxy variables only with this switch.
        'NODE_USE_ENV_PROXY=1',
      ],
      // the code container finds the relay by its name through the dns of the docker network.
      extraHosts: [],
      passed: () => [...passed],
      refused: () => [...refused],
      close,
    };
  }

  return { check, open };
}

// the body of the relay container. ContainerSpec is the type of the code container, and the relay also needs a second
// network at create time, so this body is built here and cast at one place. it has the same hardening as the code
// container, with less memory and fewer processes.
function relayBody(spec: {
  image: string;
  labels: Record<string, string>;
  network: string;
  relay: string;
  proxyHost: string;
  port: string;
  readyHost: string;
  extraHosts: string[];
}): ContainerSpec {
  const memory = 64 * 1024 * 1024;
  const body = {
    Image: spec.image,
    Cmd: ['node', RELAY_SCRIPT, spec.proxyHost, spec.port, spec.readyHost],
    Env: [],
    WorkingDir: '/',
    User: SANDBOX_USER,
    Labels: spec.labels,
    AttachStdout: false,
    AttachStderr: false,
    AttachStdin: false,
    Tty: false,
    OpenStdin: false,
    NetworkDisabled: false,
    HostConfig: {
      NetworkMode: 'bridge',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      NanoCpus: 0.5e9,
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: 32,
      Tmpfs: {},
      Mounts: [],
      ExtraHosts: spec.extraHosts,
      Init: true,
      AutoRemove: false,
    },
    // the relay is on the bridge, which reaches the proxy, and on the internal network of the call, where the code
    // container finds it by its name.
    NetworkingConfig: { EndpointsConfig: { bridge: {}, [spec.network]: { Aliases: [spec.relay] } } },
  };
  return body as unknown as ContainerSpec;
}

// sweepNetworks removes the sandbox networks of this instance whose exec does not run now, for example after a crash.
// the relay containers carry the same labels, so sweepContainers in runner.ts removes them first. it gives the number
// of networks that it removed.
export async function sweepNetworks(
  docker: Pick<DockerClient, 'listNetworks' | 'removeNetwork'>,
  instance: string,
  keep: (execId: number) => boolean,
): Promise<number> {
  let removed = 0;
  for (const each of await docker.listNetworks(`${LABELS.instance}=${instance}`)) {
    if (each.labels[LABELS.sandbox] !== '1' || each.labels[LABELS.instance] !== instance) continue;
    const execId = Number(each.labels[LABELS.exec]);
    if (Number.isInteger(execId) && keep(execId)) continue;
    await docker.removeNetwork(each.name);
    removed += 1;
  }
  return removed;
}
