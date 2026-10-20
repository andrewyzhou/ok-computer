import type { Db } from '../db/index.js';
import type { Tool } from '../tools/registry.js';

// the chat tools of the trust ladder (docs/PHASE6-PLAN.md, track T6). autonomy_levels reads the level of each domain,
// and autonomy_lower lowers one when the owner asks for it in chat. no tool can raise a level: only the owner can, on
// the dashboard. the names go in MAIN_TOOLS (src/sessions/router.ts) when the tools are built, so only an owner chat
// has them.
export const LEVELS_TOOL = 'autonomy_levels';
export const LOWER_TOOL = 'autonomy_lower';

export interface AutonomyToolDeps {
  db: Db;
}

// the list is empty until the tools are built, so the app registers no tool that throws.
export function createAutonomyTools(deps: AutonomyToolDeps): Tool[] {
  void deps;
  return [];
}
