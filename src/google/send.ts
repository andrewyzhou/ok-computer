import type { ToolOutput } from '../tools/registry.js';
import type { GoogleAccounts } from './accounts.js';
import { toGoogleError } from './errors.js';
import { failed } from './failed.js';
import { badAddress, rawMessage, type Draft } from './mime.js';

// a send goes through a draft, because gmail has no idempotency key. when the answer is lost, the draft tells what
// happened: google deletes a draft when it sends it.
export async function sendDraft(accounts: GoogleAccounts, tool: string, alias: string, draft: Draft & { threadId?: string }): Promise<ToolOutput> {
  const bad = badAddress([...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])]);
  if (bad !== undefined) return { content: `${tool} did not run: ${JSON.stringify(bad)} is not a plain email address.`, isError: true, effect: 'none' };
  let draftId: string;
  try {
    const created = await accounts.run(alias, (apis) =>
      apis.gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: rawMessage(draft), ...(draft.threadId ? { threadId: draft.threadId } : {}) } } }),
    );
    draftId = created.data.id!;
  } catch (err) {
    // no mail left in this step. at worst a draft stays.
    return { ...failed(tool, alias, toGoogleError(err), true), effect: 'none' };
  }
  try {
    const sent = await accounts.run(alias, (apis) => apis.gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } }));
    return { content: `sent from ${alias} to ${draft.to.join(', ')} as message ${sent.data.id}.` };
  } catch (err) {
    const error = toGoogleError(err);
    if (!error.reached || (error.status !== undefined && error.status < 500)) {
      return { content: `${tool} did not send from ${alias}: ${error.message}. The draft ${draftId} stays in Drafts.`, isError: true, effect: 'none' };
    }
    try {
      await accounts.run(alias, (apis) => apis.gmail.users.drafts.get({ userId: 'me', id: draftId }));
      // a 5xx answer ends the send. without an answer, google can still be at work on it, and the draft goes only
      // when the send ends. a second approval could then send the mail twice, so the effect is unknown.
      if (error.status !== undefined) {
        return { content: `${tool} did not send from ${alias} (${error.message}). Google still has the draft ${draftId}, so the message did not go out.`, isError: true, effect: 'none' };
      }
      return {
        content: `${tool} got no answer from google (${error.message}). The draft ${draftId} is still there, but google can still be sending it. Check the Sent folder before you try again.`,
        isError: true,
        effect: 'unknown',
      };
    } catch (check) {
      if (toGoogleError(check).kind === 'not_found') return { content: `sent from ${alias} to ${draft.to.join(', ')}. The answer was lost (${error.message}), but google no longer has the draft, so it went out.` };
      return failed(tool, alias, error, true);
    }
  }
}
