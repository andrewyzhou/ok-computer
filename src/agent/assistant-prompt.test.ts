import { describe, expect, it } from 'vitest';
import { BRIEF_INSTRUCTIONS } from '../brief/prompt.js';
import { DESK_INSTRUCTIONS } from '../desk/prompt.js';
import { DOCS_INSTRUCTIONS } from '../docs/prompt.js';
import { PEOPLE_INSTRUCTIONS } from '../people/prompt.js';
import { ASSISTANT_OPENING, assistantInstructions } from './assistant-prompt.js';

describe('the assistant instructions', () => {
  it('give one opening and then the part of each track whose tool the session has, in a fixed order', () => {
    const all = assistantInstructions(['person_note', 'brief_read', 'doc_write', 'delegation_create', 'now']);
    expect(all).toBe([ASSISTANT_OPENING, DESK_INSTRUCTIONS, DOCS_INSTRUCTIONS, PEOPLE_INSTRUCTIONS, BRIEF_INSTRUCTIONS].join('\n\n'));
    expect(assistantInstructions(['doc_write', 'doc_read'])).toBe([ASSISTANT_OPENING, DOCS_INSTRUCTIONS].join('\n\n'));
  });

  it('give nothing to a session without a tool of a part', () => {
    expect(assistantInstructions([])).toBe('');
    // the read tools alone, as an auto-read automation or the research sub-agent has them, need no guidance.
    expect(assistantInstructions(['delegation_list', 'doc_read', 'person_lookup', 'people_search'])).toBe('');
  });

  it('keep the voice of an assistant that decides and does not ask or repeat the request', () => {
    expect(ASSISTANT_OPENING).toContain('without asking');
    expect(ASSISTANT_OPENING).toContain('Never restate the owner');
    expect(ASSISTANT_OPENING).toContain('Do not report your own bookkeeping');
    for (const part of [DESK_INSTRUCTIONS, PEOPLE_INSTRUCTIONS]) expect(part).toContain('Do not ask first.');
    expect(DOCS_INSTRUCTIONS).toContain('pick the kind yourself');
    // every part is one paragraph, so the set reads as one list of topics.
    for (const part of [DESK_INSTRUCTIONS, DOCS_INSTRUCTIONS, PEOPLE_INSTRUCTIONS, BRIEF_INSTRUCTIONS]) expect(part).not.toContain('\n');
  });
});
