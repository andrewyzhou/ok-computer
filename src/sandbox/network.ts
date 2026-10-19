import type { Logger } from '../observability/logger.js';
import type { Egress } from '../web/egress.js';
import type { DockerClient, NetworkGate } from './types.js';

// a call with network access reaches the internet only through the egress proxy of the app (src/browser/proxy.ts),
// with the hosts of its allowlist. the container has no other route out: a direct connection to any address fails.
// when this host cannot give that, check() says why, and a call with an allowlist fails while a call without one works.

export function createNetworkGate(_deps: { docker: DockerClient; egress: Egress; logger: Logger; instance: string }): NetworkGate {
  throw new Error('not built: createNetworkGate');
}

// checkAllowlist gives the reason when an entry is too broad (a public suffix such as com or co.uk, see tooBroad in
// src/browser/gate.ts) or not a host name. it gives undefined for a good list.
export function checkAllowlist(_allowlist: readonly string[]): string | undefined {
  throw new Error('not built: checkAllowlist');
}
