import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { dataUrls, SEEN_CHECKS, sourceNames, type Reviewer } from './policy.js';
import { sessionTaint, urlSeen } from './store.js';

// the final reply of a run goes to the owner's chat with no tool call, and a chat app fetches a link preview. so in a
// tainted session the reply can carry data out in a link, as a message_owner call can. the guard uses the same
// signals and the same verbatim exemption as the policy. the reviewer checks a reply with a link that the session did
// not read. a hold, or a reviewer that fails, removes each such link from the text that goes to the chat. the event
// log keeps the full reply, so the owner can read it on the run page.
export const REPLY_TOOL = 'reply_to_owner';
export const REMOVED_LINK = '[link removed: it can carry data out of this session. The run page on the dashboard shows it.]';
export const REMOVED_REPLY = 'The reply has a link that can carry data out of this session, so it did not come to the chat. The run page on the dashboard shows it.';

export interface ReplyGuardDeps {
  db: Db;
  reviewer?: Reviewer;
  logger: Logger;
}

export async function guardReply(deps: ReplyGuardDeps, run: { runId: string; sessionKey: string; signal?: AbortSignal }, text: string): Promise<string> {
  const found = dataUrls(text);
  if (!found.length) return text;
  const taint = sessionTaint(deps.db, run.sessionKey).map((each) => each.source);
  if (!taint.length) return text;
  const unseen = found.length > SEEN_CHECKS ? found : found.filter((each) => !urlSeen(deps.db, run.sessionKey, each.url));
  if (!unseen.length) return text;
  const reason = `the session read untrusted content (${sourceNames(taint)}), and the final reply has a link that can carry data (${unseen[0]!.url}): ${unseen[0]!.signal}, so a reviewer checks it first`;
  try {
    const review = await deps.reviewer?.({
      runId: run.runId,
      sessionKey: run.sessionKey,
      tool: REPLY_TOOL,
      input: { text },
      risk: 'write',
      reason,
      taint,
      signal: run.signal ?? new AbortController().signal,
    });
    if (review?.verdict === 'allow') return text;
    deps.logger.warn('links removed from a reply', { runId: run.runId, reason: review?.reason ?? 'no reviewer' });
  } catch (err) {
    deps.logger.warn('links removed from a reply, because the review failed', { runId: run.runId, err });
  }
  return withoutLinks(text, unseen.map((each) => each.url));
}

// a chat app makes a link only of the text up to a space or a quote. a longer link goes first, so a shorter link
// inside it cannot leave a part of it. the finder reads the nfkc form, so a link that the text does not hold verbatim
// makes the whole reply go.
function withoutLinks(text: string, urls: string[]): string {
  const links = [...new Set(urls.map((url) => url.split(/[\s"'<>]/)[0]!))].sort((a, b) => b.length - a.length);
  if (links.some((link) => !text.includes(link))) return REMOVED_REPLY;
  return links.reduce((out, link) => out.split(link).join(REMOVED_LINK), text);
}
