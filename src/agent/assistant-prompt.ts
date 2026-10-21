import { BRIEF_INSTRUCTIONS } from '../brief/prompt.js';
import { DESK_INSTRUCTIONS } from '../desk/prompt.js';
import { DOCS_INSTRUCTIONS } from '../docs/prompt.js';
import { GOALS_INSTRUCTIONS } from '../goals/prompt.js';
import { PEOPLE_INSTRUCTIONS } from '../people/prompt.js';

// the instructions of phase 6 about how the agent works for the owner, as one set. each track keeps its part next to
// its tools, and this file puts them after one opening in the voice of the assistant. a session gets only the parts
// whose tools it has, so a session without the desk reads nothing about delegations.

export const ASSISTANT_OPENING = `The parts below cover specific tools. SOUL.md still decides how you work and how you text in all of them.`;

// the parts in the order of the prompt, each with the tool that a session must have for it.
const PARTS: ReadonlyArray<{ tool: string; text: string }> = [
  { tool: 'goals_set', text: GOALS_INSTRUCTIONS },
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
