import type { SandboxLanguage } from '../dashboard/types.js';
import type { Logger } from '../observability/logger.js';
import type { ContainerSpec, DockerClient, ExecRequest, Runner } from './types.js';

// the runner runs one exec in a fresh container: create, put the files in, attach, start, wait with the wall time
// limit, read the collect paths, and remove the container in every case.

// commandFor gives the argv of the code. the code is one argument, so no shell quoting is needed.
export function commandFor(_language: SandboxLanguage, _code: string): string[] {
  throw new Error('not built: commandFor');
}

// containerSpec gives the body of the create request, with the labels of the instance and the exec. it is a pure
// function, so a test checks each limit and each security setting without docker.
export function containerSpec(_request: ExecRequest, _instance: string): ContainerSpec {
  throw new Error('not built: containerSpec');
}

// the name of the container of an exec. a sweep finds it by its labels, not by the name.
export const containerName = (instance: string, execId: number) => `okc-sandbox-${instance}-${execId}`;

export function createRunner(_deps: { docker: DockerClient; logger: Logger; instance: string; now?: () => number }): Runner {
  throw new Error('not built: createRunner');
}

// sweepContainers removes the sandbox containers of this instance whose exec does not run now, for example after a
// crash. npm run chat and the service share an instance, so keep reads the trace row and not a set of this process:
// it is true for a running row that is not stale. the function gives the number of containers that it removed.
export async function sweepContainers(_docker: DockerClient, _instance: string, _keep: (execId: number) => boolean): Promise<number> {
  throw new Error('not built: sweepContainers');
}
