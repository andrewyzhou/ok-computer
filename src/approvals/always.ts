import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Result } from '../config/load.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { loadPolicy, type Rule } from '../policy/policy.js';
import type { Card } from '../sessions/commands.js';
import { localDay, type Clock } from '../time.js';
import type { Tool } from '../tools/registry.js';
import { approvalButtonData, getApproval, type Approval } from './store.js';
import type { ApprovalFlow } from './flow.js';

// a confirmation is valid for this time. an old "yes" in the chat history must not add a rule days later.
const CONFIRM_MS = 10 * 60_000;

// the "yes" button carries its expiry in seconds, in base 36, so the data stays short.
export const alwaysButtonData = (id: number, expires?: Date) =>
  expires ? `approval:${id}:always-yes:${Math.floor(expires.getTime() / 1000).toString(36)}` : `approval:${id}:always`;

export function parseAlwaysButton(data: string): { id: number; expires?: Date } | undefined {
  const match = /^approval:(\d+):always(?:-yes:([0-9a-z]{1,10}))?$/.exec(data);
  if (!match) return undefined;
  return { id: Number(match[1]), ...(match[2] ? { expires: new Date(parseInt(match[2], 36) * 1000) } : {}) };
}

// only an external tool without needsApproval can get an allow rule. a rule cannot change needsApproval, and the allow
// rule of a write tool would also hold in a session that read outside content.
export const alwaysAllowable = (tool: Pick<Tool, 'risk' | 'needsApproval'>) => tool.risk === 'external' && !tool.needsApproval;

export interface AlwaysAllowDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  timeZone: string;
  policyPath: string;
  // the caller reads this list at each call. the new rule goes into it, so it works without a restart.
  rules: Rule[];
  resolve: ApprovalFlow['resolve'];
  // the tool of the approval as the current config gives it, or undefined when the session lost it. a card from before
  // a restart can name a tool whose risk changed since then.
  toolOf: (approval: Approval) => Pick<Tool, 'risk' | 'needsApproval'> | undefined;
}

// "always allow" adds an allow rule for the tool to okc.policy.json, then approves the call. a second button
// confirms it, because one wrong tap would open a tool for good.
export function createAlwaysAllow(deps: AlwaysAllowDeps) {
  const pending = (id: number) => {
    const approval = getApproval(deps.db, id);
    if (!approval) return { error: `No approval has the id ${id}.` };
    if (approval.status !== 'pending') return { error: `Approval #${id} is already ${approval.status}.` };
    const tool = deps.toolOf(approval);
    if (!tool || !alwaysAllowable(tool)) {
      return { error: `${approval.toolName} cannot be always allowed now, because its risk changed or the session lost it. Approve or deny approval #${id} on its card.` };
    }
    return { approval };
  };

  return {
    confirm(id: number): Card {
      const { approval, error } = pending(id);
      if (!approval) return { text: error };
      const tool = approval.toolName;
      return {
        text: [
          `Always allow ${tool}? Each later call of ${tool}, with any input and in every session, then runs without asking you.`,
          'A session that read outside content still asks. But text that such a session saved as a goal or in memory can steer a later session, for example after /new, and that session then runs the tool without asking.',
          'A deny rule in okc.policy.json still wins. The rule goes into okc.policy.json, where you can remove it.',
          'This question is valid for 10 minutes.',
        ].join('\n'),
        buttons: [
          [{ text: `Yes, always allow ${tool}`, data: alwaysButtonData(id, new Date(deps.clock().getTime() + CONFIRM_MS)) }],
          [
            { text: 'Approve once', data: approvalButtonData(id, 'approve') },
            { text: 'Deny', data: approvalButtonData(id, 'deny') },
          ],
        ],
      };
    },

    // the rule goes in first, and then the approval resolves. if the resolve fails, the approval stays pending and
    // the owner can press approve again. the rule is then already there, so nothing is added twice.
    async apply(id: number, expires: Date): Promise<string> {
      if (deps.clock() > expires) return 'That confirmation expired, so nothing changed. Press "Always allow…" on the card again.';
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

// the file is written to a temporary name and checked by the same loader as the start, then renamed. so a crash
// never leaves half a file, and a refused file never replaces the old one. a rule that the file already has is not
// added again.
export function addRule(path: string, rule: Omit<Rule, 'id'>): Result<Rule[]> {
  let file: { rules?: unknown[] } = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as { rules?: unknown[] };
    } catch (err) {
      return { ok: false, error: `${path} is not valid json: ${(err as Error).message}` };
    }
  }
  const rules = Array.isArray(file.rules) ? file.rules : [];
  const same = rules.some((each) => {
    const old = each as Partial<Rule>;
    return old.tool?.toLowerCase() === rule.tool.toLowerCase() && old.effect === rule.effect && old.session === undefined && old.args === undefined;
  });
  if (same) return loadPolicy(path);
  const temporary = `${path}.tmp`;
  // on windows an editor or a virus scanner can lock the file, so the write or the rename can fail. the old file
  // then stays, and the owner gets the reason.
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...file, rules: [...rules, rule] }, null, 2)}\n`);
    const checked = loadPolicy(temporary);
    if (!checked.ok) {
      rmSync(temporary, { force: true });
      return { ok: false, error: checked.error.replaceAll(temporary, path) };
    }
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    return { ok: false, error: `${path} could not be written: ${(err as Error).message}` };
  }
  return loadPolicy(path);
}
