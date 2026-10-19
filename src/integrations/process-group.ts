import type { Readable } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/client';
import type { Logger } from '../observability/logger.js';

// the parameters of a stdio server on macos and linux. they are the same as the parameters that transports.ts gives
// the stdio transport of the sdk on windows.
export interface GroupStdioParams {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

// a stdio transport whose server leads its own process group. stderr is a stream from the start, so the caller can
// read the first lines, and pid is the pid of the server, which is also the id of its group.
export type GroupStdioTransport = Transport & { readonly stderr: Readable; readonly pid: number | null };

// groupStdioTransport starts the server detached on macos and linux, so it leads a new process group. its close ends
// stdin, then sends SIGTERM and later SIGKILL to the whole group, so a server that npx or a shell started does not live
// on after a stop.
export function groupStdioTransport(params: GroupStdioParams, id: string, logger: Logger): GroupStdioTransport {
  void params;
  void id;
  void logger;
  throw new Error('groupStdioTransport is not built');
}

// killProcessGroup sends SIGTERM to the group, waits up to graceMs for it to end, and then sends SIGKILL. it gives
// true when a process of the group was still alive at the first signal.
export async function killProcessGroup(pgid: number, graceMs = 2_000): Promise<boolean> {
  void pgid;
  void graceMs;
  throw new Error('killProcessGroup is not built');
}
