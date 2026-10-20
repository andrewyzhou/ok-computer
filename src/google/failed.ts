import type { ToolOutput } from '../tools/registry.js';
import type { GoogleError } from './errors.js';

// this lives apart from send.ts, so the inbox jobs and their quality check do not import the module that sends.
// a failed write says whether google can have acted. no answer after the request left means that the effect is
// unknown. a refused connection, or a 4xx answer, means that google did not act, so a retry is safe.
export function failed(tool: string, alias: string, error: GoogleError, write: boolean): ToolOutput {
  const hint =
    error.kind === 'scope'
      ? ' The sign-in lacks a permission; the owner connects the account again and ticks every box.'
      : error.kind === 'rate'
        ? ' Google limits the rate; try again in a few minutes.'
        : '';
  const answered = error.status !== undefined && error.status < 500;
  const effect = !write || !error.reached || answered ? ('none' as const) : ('unknown' as const);
  const unknown = effect === 'unknown' ? ' The request left, but no answer came, so it is unknown whether it worked. Check before you try again.' : '';
  return { content: `${tool} failed for ${alias}: ${error.message}.${hint}${unknown}`, isError: true, ...(write ? { effect } : {}) };
}
