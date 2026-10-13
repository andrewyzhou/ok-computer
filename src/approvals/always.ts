import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Result } from '../config/load.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { loadPolicy, type Rule } from '../policy/policy.js';
import type { Card } from '../sessions/commands.js';
import { localDay, type Clock } from '../time.js';
import { approvalButtonData, getApproval } from './store.js';
import type { ApprovalFlow } from './flow.js';

export const alwaysButtonData = (id: number, confirmed: boolean) => `approval:${id}:${confirmed ? 'always-yes' : 'always'}`;

export function parseAlwaysButton(data: string): { id: number; confirmed: boolean } | undefined {
  const match = /^approval:(\d+):always(-yes)?$/.exec(data);
  return match ? { id: Number(match[1]), confirmed: match[2] !== undefined } : undefined;
}

export interface AlwaysAllowDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  timeZone: string;
  policyPath: string;
  // the caller reads this list at each call. the new rule goes into it, so it works without a restart.
  rules: Rule[];
  resolve: ApprovalFlow['resolve'];
}

// "always allow" adds an allow rule for the tool to okc.policy.json, then approves the call. a second button
// confirms it, because one wrong tap would open a tool for good.
export function createAlwaysAllow(deps: AlwaysAllowDeps) {
  const pending = (id: number) => {
    const approval = getApproval(deps.db, id);
    if (!approval) return { error: `No approval has the id ${id}.` };
    if (approval.status !== 'pending') return { error: `Approval #${id} is ${approval.status}.` };
    return { approval };
  };

  return {
    confirm(id: number): Card {
      const { approval, error } = pending(id);
      if (!approval) return { text: error };
      return {
        text:
          `Always allow ${approval.toolName}? Each later call of ${approval.toolName}, with any input, then runs without asking you. ` +
          'It still asks after the session read untrusted content, and a deny rule in okc.policy.json still wins. ' +
          'The rule goes into okc.policy.json, where you can remove it.',
        buttons: [
          [{ text: `Yes, always allow ${approval.toolName}`, data: alwaysButtonData(id, true) }],
          [
            { text: 'Approve once', data: approvalButtonData(id, 'approve') },
            { text: 'Deny', data: approvalButtonData(id, 'deny') },
          ],
        ],
      };
    },

    async apply(id: number): Promise<string> {
      const { approval, error } = pending(id);
      if (!approval) return error;
      const rule = { tool: approval.toolName, effect: 'allow' as const, note: `the owner allowed it from approval #${id} on ${localDay(deps.clock(), deps.timeZone)}` };
      const added = addRule(deps.policyPath, rule);
      if (!added.ok) {
        deps.logger.error('always allow failed', { approvalId: id, error: added.error });
        return `I could not add the rule, so nothing changed: ${added.error}`;
      }
      deps.rules.splice(0, deps.rules.length, ...added.value);
      deps.logger.info('the owner added an allow rule', { approvalId: id, tool: approval.toolName });
      return `${approval.toolName} is now always allowed.\n${await deps.resolve(id, 'approve', 'button')}`;
    },
  };
}

// the file is written to a temporary name and renamed, so a crash never leaves half a file. the result goes through
// the same loader as the start. if the loader refuses it, the old file comes back.
export function addRule(path: string, rule: Omit<Rule, 'id'>): Result<Rule[]> {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  let file: { rules?: unknown[] };
  try {
    file = before === undefined ? {} : (JSON.parse(before) as { rules?: unknown[] });
  } catch (err) {
    return { ok: false, error: `${path} is not valid json: ${(err as Error).message}` };
  }
  const next = { ...file, rules: [...(Array.isArray(file.rules) ? file.rules : []), rule] };
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, path);
  const loaded = loadPolicy(path);
  if (!loaded.ok) {
    if (before === undefined) rmSync(path);
    else writeFileSync(path, before);
  }
  return loaded;
}
