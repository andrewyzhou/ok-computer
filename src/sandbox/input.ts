import { z } from 'zod';
import { CODE_BYTES, FILE_LIMITS, MAX_LIMITS } from './limits.js';

// the input of sandbox_exec. it is a contract between the tool, the file handling and the network gate, so it lives in
// its own file. a path is relative to /work. the checks of a path that a schema cannot do (a ".." segment, a reserved
// folder) are in files.ts, and the call gets the reason.
const relativePath = z
  .string()
  .min(1)
  .max(FILE_LIMITS.pathChars)
  .regex(/^[^/\\\0]/, 'use a path relative to /work, for example data/input.csv')
  .describe('a path relative to /work');

// a host name that the call may reach. an entry also allows its subdomains, as in the browser allowlist.
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i, 'use a host name such as pypi.org, without a scheme or a path');

const fileIn = z.strictObject({
  path: relativePath,
  // give content for a text file that the call writes, or blob for a file that an earlier exec or the owner made.
  content: z.string().max(1_000_000).optional().describe('the text of the file'),
  blob: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'use the blob hash that an earlier sandbox_exec result gave')
    .optional()
    .describe('the blob hash of a file from an earlier sandbox_exec result'),
});

export const sandboxExecInput = z.strictObject({
  language: z.enum(['bash', 'python', 'node']).describe('bash runs the code with bash -c, python with python3 -c, node with node -e'),
  code: z
    .string()
    .min(1)
    .refine((code) => Buffer.byteLength(code) <= CODE_BYTES, `use at most ${CODE_BYTES} bytes of code. put a long program in a file`)
    // an argv entry cannot hold a nul byte, and the trace would cut the code at it.
    .refine((code) => !code.includes('\u0000'), 'remove the nul character from the code. put binary data in a file')
    .describe('the code to run. the working directory is /work'),
  files: z.array(fileIn).max(FILE_LIMITS.count).optional().describe('files to put into /work before the code runs'),
  collect: z
    .array(relativePath)
    .max(FILE_LIMITS.count)
    .optional()
    .describe('files or folders under /work to return after the code ends. each file gets a blob hash'),
  timeoutMs: z.number().int().min(1_000).max(MAX_LIMITS.timeoutMs).optional().describe('the wall time limit in ms'),
  memoryMb: z.number().int().min(64).max(MAX_LIMITS.memoryMb).optional().describe('the memory limit in MB'),
  cpus: z.number().min(0.5).max(MAX_LIMITS.cpus).optional().describe('the number of cpus, for example 2'),
  network: z
    .strictObject({
      allow: z.array(host).min(1).max(10),
    })
    .optional()
    .describe('ask for network access to these hosts only, through a proxy. the owner approves each such call'),
});

export type SandboxExecInput = z.infer<typeof sandboxExecInput>;
