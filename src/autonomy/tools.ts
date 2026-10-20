import { z } from 'zod';
import type { Db } from '../db/index.js';
import { DOMAIN_IDS, DOMAINS, domainSpec, LEVEL_TEXT, type AutonomyDomain } from '../policy/autonomy.js';
import { AutonomyError, changeLevel, storedLevels } from '../policy/autonomy-store.js';
import { MAIN_SESSION } from '../sessions/router.js';
import { defineTool, type Tool } from '../tools/registry.js';

// the chat tools of the trust ladder (docs/PHASE6-PLAN.md, track T6). autonomy_levels reads the level of each domain,
// and autonomy_lower lowers one when the owner asks for it in chat. no tool can raise a level: only the owner can, on
// the dashboard. the names are in MAIN_TOOLS (src/sessions/router.ts), so only an owner chat has them.
export const LEVELS_TOOL = 'autonomy_levels';
export const LOWER_TOOL = 'autonomy_lower';

export interface AutonomyToolDeps {
  db: Db;
}

const RAISE_NOTE = 'Only the owner can raise a level, on the dashboard at Agent > Autonomy. The agent can lower one when the owner asks.';

// the levels that autonomy_lower takes. auto is not in the list, so a call that asks for it fails the schema and never
// reaches the store.
const LOWER_LEVELS = ['ask', 'review'] as const;

export function createAutonomyTools(deps: AutonomyToolDeps): Tool[] {
  const { db } = deps;

  const levels = defineTool({
    name: LEVELS_TOOL,
    description: `Show the autonomy level of each domain of actions, its default and the most it can go up to. ask: ${LEVEL_TEXT.ask} review: ${LEVEL_TEXT.review} auto: ${LEVEL_TEXT.auto}`,
    input: z.object({}),
    risk: 'read',
    async run() {
      const stored = storedLevels(db);
      const lines = DOMAINS.map((spec) => {
        const head = `${spec.id} (${spec.label}): ${stored[spec.id].level}`;
        if (spec.fixedReason !== null) return `${head}; it always stays at ask: ${spec.fixedReason}`;
        return `${head}; the default is ${spec.defaultLevel}; it can go up to ${spec.maxLevel}`;
      });
      return { content: [...lines, RAISE_NOTE].join('\n') };
    },
  });

  const lower = defineTool({
    name: LOWER_TOOL,
    description:
      'Lower the autonomy level of one domain, so that the agent checks more before it acts there. Use it only when the owner asks in this chat for more checks. It cannot raise a level: only the owner can, on the dashboard.',
    input: z
      .object({
        domain: z.enum(DOMAIN_IDS as [AutonomyDomain, ...AutonomyDomain[]]).describe('The domain, as autonomy_levels names it.'),
        level: z.enum(LOWER_LEVELS).describe('The new level. ask: the owner approves each action. review: a second model checks each action.'),
        reason: z.string().min(1).max(500).describe("The owner's words or reason for the change. The history keeps it."),
      })
      .strict(),
    risk: 'write',
    async run(input, ctx) {
      // only the owner's chat speaks for the owner. a sub-agent, an automation, the heartbeat and the workshop run in
      // other sessions, so they cannot change a level, also not to lower it.
      if (ctx.sessionKey !== MAIN_SESSION) {
        return { content: `${LOWER_TOOL} works only in the owner's chat, and this run is in the session ${ctx.sessionKey}.`, isError: true, effect: 'none' };
      }
      const { domain } = input;
      const { label } = domainSpec(domain);
      try {
        const row = changeLevel(
          db,
          {
            domain,
            level: input.level,
            actor: 'agent',
            via: 'chat',
            runId: ctx.runId,
            toolCallId: ctx.toolCallId ?? null,
            sessionKey: ctx.sessionKey,
            note: input.reason,
          },
          ctx.clock(),
        );
        if (!row) return { content: `${label} is already at ${input.level}.` };
        return { content: `${label} is now at ${row.toLevel} (it was ${row.fromLevel}). The owner can raise it again on the dashboard.` };
      } catch (err) {
        // a refused change did not write anything, so the model gets the reason and a retry is safe. any other error
        // goes up, so the caller records it.
        if (err instanceof AutonomyError) return { content: err.message, isError: true, effect: 'none' };
        throw err;
      }
    },
  });

  return [levels, lower];
}
