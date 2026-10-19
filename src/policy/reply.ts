import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import { dataUrls, linkOf, reviewCallOf, sourceNames, unseenUrls, type ReviewResult, type Reviewer } from './policy.js';
import { recordDecision, sessionTaint, updateDecision, urlSeen } from './store.js';

// the final reply of a run goes to the owner's chat with no tool call, and a chat app fetches a link preview. so in a
// tainted session the reply can carry data out in a link, as a message_owner call can. the guard uses the same
// signals and the same verbatim exemption as the policy. the reviewer checks a reply with a link that the session did
// not read. a hold, or a reviewer that fails, removes each such link from the text that goes to the chat. the event
// log keeps the full reply, so the owner can read it on the run page.
export const REPLY_TOOL = 'reply_to_owner';
// the decision of the guard has no tool call. this id links it to the final reply of its run.
export const REPLY_CALL_ID = 'reply';
export const REMOVED_LINK = '[link removed: it can carry data out of this session. The run page on the dashboard shows it.]';
export const REMOVED_REPLY = 'The reply has a link that can carry data out of this session, so it did not come to the chat. The run page on the dashboard shows it.';
// the note tells the model and the run page that the chat did not get the reply that the log holds.
export const REPLY_NOTE = "The final reply did not go to the owner's chat as it is";

export interface ReplyGuardDeps {
  db: Db;
  reviewer?: Reviewer;
  logger: Logger;
  clock: Clock;
}

export async function guardReply(
  deps: ReplyGuardDeps,
  run: { runId: string; sessionKey: string; signal?: AbortSignal },
  text: string,
): Promise<string> {
  const { db, clock } = deps;
  const found = dataUrls(text);
  if (!found.length) return text;
  const taint = sessionTaint(db, run.sessionKey);
  if (!taint.length) return text;
  const unseen = unseenUrls(found, (url) => urlSeen(db, run.sessionKey, url));
  if (!unseen.length) return text;
  const sources = taint.map((each) => each.source);
  const reason = `the session read untrusted content (${sourceNames(sources)}), and the final reply has a link that can carry data (${unseen[0]!.url}): ${unseen[0]!.signal}, so a reviewer checks it first`;
  // the trace keeps the decision and the verdict, so the run page shows what went to the chat.
  const decisionId = recordDecision(
    db,
    { runId: run.runId, toolCallId: REPLY_CALL_ID, toolName: REPLY_TOOL, decision: 'review', rule: 'exfiltration', reason, taint },
    clock(),
  );
  let review: ReviewResult | undefined;
  let failed = false;
  try {
    review = await deps.reviewer?.({
      runId: run.runId,
      sessionKey: run.sessionKey,
      tool: REPLY_TOOL,
      input: { text },
      risk: 'write',
      reason,
      taint: sources,
      signal: run.signal ?? new AbortController().signal,
    });
  } catch (err) {
    deps.logger.warn('the review of a reply failed', { runId: run.runId, err });
    // the trace keeps the failure and the paid model call, as for a tool call.
    failed = true;
    updateDecision(db, decisionId, { reason: `${reason}. the reviewer failed (${errorText(err)})`, reviewerModelCallId: reviewCallOf(err) });
  }
  if (review) updateDecision(db, decisionId, { review });
  if (review?.verdict === 'allow') return text;
  const sent = withoutLinks(text, unseen.map((each) => each.url));
  const why = review ? 'the reviewer held it' : failed ? 'the review failed' : 'it had no review';
  const what = sent === REMOVED_REPLY ? 'the chat got only a short notice in its place' : 'the chat got it without the links that can carry data';
  // the note does not repeat the links. the next run reads it, so the model knows that the owner did not see them.
  appendEvent(db, { sessionKey: run.sessionKey, runId: run.runId, type: 'note', payload: { text: `${REPLY_NOTE}: ${why}, so ${what}.` } }, clock());
  deps.logger.warn('links removed from a reply', { runId: run.runId, why });
  return sent;
}

// a draft shows the text of a model call while it streams, before the guard reads the final reply. a chat app makes a
// link of the draft text too. so in a tainted session each link that can carry data becomes a short mark. a draft has
// no review, so a link that the session read also gets the mark. the final reply shows it after the guard.
export const DRAFT_LINK = '[link]';

export function guardDraft(db: Db, sessionKey: string, text: string): string {
  if (!sessionTaint(db, sessionKey).length) return text;
  const found = dataUrls(text);
  if (!found.length) return text;
  return replaceLinks(text, found.map((each) => each.url), DRAFT_LINK) ?? '';
}

export function withoutLinks(text: string, urls: string[]): string {
  return replaceLinks(text, urls, REMOVED_LINK) ?? REMOVED_REPLY;
}

// a chat app makes a link only of the text up to a space or a double quote. a longer link goes first, so a shorter link
// inside it cannot leave a part of it. the finder reads the nfkc form, so a link that the text does not hold verbatim
// gives undefined, and the caller does not send the text.
function replaceLinks(text: string, urls: string[], mark: string): string | undefined {
  const links = [...new Set(urls.map(linkOf))].sort((a, b) => b.length - a.length);
  if (links.some((link) => !text.includes(link))) return undefined;
  return links.reduce((out, link) => out.split(link).join(mark), text);
}
