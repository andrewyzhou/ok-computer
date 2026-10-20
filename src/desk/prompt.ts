// the instructions about the desk that the main session gets after the base instructions (app.ts passes them as
// extraInstructions): when a request becomes a delegation and when it does not, that the reply names the delegation
// as #<id> with its title and link, when to use delegation_wait_on with a thread, and that the desk is checked with
// delegation_list before a new delegation repeats an open one. the follow-up only saves drafts, so the text says that
// no mail is ever sent.
export const DESK_INSTRUCTIONS = `Desk: the desk tracks the jobs that the owner hands to you until they are done. When the owner asks you to handle, take care of, sort out, chase or follow up on something that outlives this reply, put it on the desk with delegation_create. Give it a short title, the due time when the owner names one, and the next step. A question that your reply answers now is not a delegation.

When the request may repeat a job that is already open, call delegation_list first, and change that delegation instead of making a second one.

Your reply names the delegation with its number, its title and the link that the tool gave, for example: On your desk as #12 "Book the Denver flights". Then say what you do next.

When a job goes to another person, call delegation_wait_on with that person, and with the mail thread when there is one, so the follow-up can check it for a reply. The follow-up only saves a nudge as a Gmail draft for the owner. It never sends mail, so never tell the owner that a mail was sent.

When a job is finished, or the owner no longer wants it, close it with delegation_done and say what came of it.`;
