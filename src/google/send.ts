import type { ToolOutput } from '../tools/registry.js';
import type { GoogleAccounts } from './accounts.js';
import { toGoogleError, type GoogleError } from './errors.js';
import { badAddress, rawMessage, type Draft } from './mime.js';

// a failed write says whether google can have acted. no answer after the request left means that the effect is
// unknown. a refused connection, or a 4xx answer, means that google did not act, so a retry is safe.
export function failed(tool: string, alias: string, error: GoogleError, write: boolean): ToolOutput {
  const hint =
    error.kind === 'scope'
      ? ' The sign-in lacks a permission; the owner connects the account again and ticks every box.'
      : error.kind === 'rate'
        ? ' Google limits the rate; try again in a few minutes.'
        : '';
  const answered = error.status !== undefined && error.status < 500;
  const effect = !write || !error.reached || answered ? ('none' as const) : ('unknown' as const);
  const unknown = effect === 'unknown' ? ' The request left, but no answer came, so it is unknown whether it worked. Check before you try again.' : '';
  return { content: `${tool} failed for ${alias}: ${error.message}.${hint}${unknown}`, isError: true, ...(write ? { effect } : {}) };
}

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
      return { content: `${tool} did not send from ${alias} (${error.message}). Google still has the draft ${draftId}, so the message did not go out.`, isError: true, effect: 'none' };
    } catch (check) {
      if (toGoogleError(check).kind === 'not_found') return { content: `sent from ${alias} to ${draft.to.join(', ')}. The answer was lost (${error.message}), but google no longer has the draft, so it went out.` };
      return failed(tool, alias, error, true);
    }
  }
}
