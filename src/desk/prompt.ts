// the instructions about the desk that the main session gets after the base instructions (app.ts passes them as
// extraInstructions). the work package "agent tools" writes them: when a request becomes a delegation ("can you
// handle X", "take care of", "follow up with"), and when it does not (a question that this reply answers); that the
// reply names the delegation as #<id> with its title; when to use delegation_wait_on with a thread; and that the
// desk is checked with delegation_list before a new delegation repeats an open one. an empty text adds nothing.
export const DESK_INSTRUCTIONS = '';
