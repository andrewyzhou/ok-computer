// the names of the desk tools that each kind of session lists. src/sessions/router.ts and src/scheduler/jobs.ts
// spread these lists into theirs, so this file imports nothing and makes no import cycle.

// the main session: the owner's chat and the automations that run in it.
export const DESK_MAIN_TOOLS: readonly string[] = ['delegation_create', 'delegation_done', 'delegation_list', 'delegation_update', 'delegation_wait_on'];

// an isolated automation run reads the desk but never changes it.
export const DESK_AUTO_TOOLS: readonly string[] = ['delegation_list'];

// the tool that saves a nudge draft. it is in the registry, but no session lists it, so only the follow-up job calls
// it, through the tool caller.
export const NUDGE_TOOL = 'desk_draft_nudge';
