import { BRIEF_INSTRUCTIONS } from '../brief/prompt.js';
import { DESK_INSTRUCTIONS } from '../desk/prompt.js';
import { DOCS_INSTRUCTIONS } from '../docs/prompt.js';
import { PEOPLE_INSTRUCTIONS } from '../people/prompt.js';

// the instructions of phase 6 about how the agent works for the owner, as one set. each track keeps its part next to
// its tools, and this file puts them after one opening in the voice of the assistant. a session gets only the parts
// whose tools it has, so a session without the desk reads nothing about delegations.

export const ASSISTANT_OPENING = `How you work for the owner: work like a top executive assistant. Act on a clear request without asking, choose sensible defaults (a title, a due time, the kind of a doc) and mention the ones that matter in a few words. Ask only for a decision that only the owner can make. Never restate the owner's request: say what you did, give the link, and name the next step. Do not report your own bookkeeping, such as lookups, person notes or memory saves; report only what changed for the owner.`;

// the parts in the order of the prompt, each with the tool that a session must have for it.
const PARTS: ReadonlyArray<{ tool: string; text: string }> = [
  { tool: 'delegation_create', text: DESK_INSTRUCTIONS },
  { tool: 'doc_write', text: DOCS_INSTRUCTIONS },
  { tool: 'person_note', text: PEOPLE_INSTRUCTIONS },
  { tool: 'brief_read', text: BRIEF_INSTRUCTIONS },
];

// assistantInstructions gives the set for a session with these tools, or an empty text when no part applies.
export function assistantInstructions(tools: readonly string[]): string {
  const have = new Set(tools);
  const parts = PARTS.filter((part) => have.has(part.tool)).map((part) => part.text);
  return parts.length ? [ASSISTANT_OPENING, ...parts].join('\n\n') : '';
}
