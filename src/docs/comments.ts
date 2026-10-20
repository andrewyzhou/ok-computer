import type { Result } from '../config/load.js';
import type { Db } from '../db/index.js';
import type { DocComment } from '../dashboard/docs-types.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { RunQueue } from '../sessions/queue.js';
import { inTransaction } from '../signals/store.js';
import type { Clock } from '../time.js';
import { getDoc, listComments } from './store.js';

// the owner's comments on a doc (doc_comments and doc_comment_deliveries of 022_docs.sql). a comment is stored at once,
// so the page shows it, and then it goes to its session as a system_event through the session queue, so it never lands
// inside an active run. the agent sees it in the next run of that session. listComments of store.ts reads them back.

export const COMMENT_CHARS = 4_000;
export const QUOTE_CHARS = 500;

// the session that gets every comment. the owner's conversation is main, and an automation session that wrote a doc
// may never run again, so a comment there would be lost.
export const COMMENT_SESSION = 'main';

export interface NewComment {
  docId: number;
  version: number;
  text: string;
  quote?: string;
}

export interface DocComments {
  // add stores the comment and queues its event. it gives an error for a doc or a version that does not exist, and
  // for a text that is empty or too long.
  add(input: NewComment): Result<DocComment>;
  // start sends each stored comment that has no delivery row, for example after the app stopped before its event was
  // written. the app calls it at its start.
  start(): void;
}

export interface DocCommentsDeps {
  db: Db;
  queue: RunQueue;
  clock: Clock;
  logger: Logger;
}

// the errors that name a row that does not exist. the route answers 404 for them and 400 for the others.
export const DOC_NOT_FOUND = 'doc not found';
export const VERSION_NOT_FOUND = 'version not found';

export function createDocComments(deps: DocCommentsDeps): DocComments {
  const { db, queue, clock, logger } = deps;

  // deliver writes the event of one comment and its delivery row in one transaction. BEGIN IMMEDIATE takes the write
  // lock before the check, and commentId is the primary key of the deliveries, so a comment never gets two events,
  // also when the service and npm run chat both start and both send the waiting comments.
  const deliver = (id: number): void => {
    inTransaction(db, () => {
      if (db.prepare('SELECT 1 FROM doc_comment_deliveries WHERE commentId = ?').get(id)) return;
      const row = db.prepare('SELECT docId FROM doc_comments WHERE id = ?').get(id);
      if (!row) return;
      const docId = Number(row.docId);
      const comment = listComments(db, docId).find((each) => each.id === id);
      const doc = getDoc(db, docId);
      if (!comment || !doc) return;
      const at = clock();
      // the event has no taint: the quote and the text are the owner's own words, and the event names the doc only by
      // its id.
      const event = appendEvent(
        db,
        { sessionKey: COMMENT_SESSION, runId: null, type: 'system_event', payload: { text: commentEventText(comment, doc.version) } },
        at,
      );
      db.prepare('INSERT INTO doc_comment_deliveries (commentId, eventId, deliveredAt) VALUES (?, ?, ?)').run(id, event.id, at.toISOString());
    });
  };

  // the event goes through the session queue, so it lands after an active run of main and never inside it.
  const queueDelivery = (id: number): void => {
    void queue
      .enqueue(COMMENT_SESSION, async () => deliver(id))
      .catch((err: unknown) => logger.error('doc comment delivery failed', { commentId: id, err }));
  };

  return {
    add(input) {
      const text = input.text.trim();
      if (!text) return { ok: false, error: 'write a comment of 1 to 4,000 characters, because this one is empty' };
      if (text.length > COMMENT_CHARS) return { ok: false, error: 'the comment has more than 4,000 characters' };
      const quote = input.quote?.trim() || null;
      if (quote !== null && quote.length > QUOTE_CHARS) return { ok: false, error: 'the quote has more than 500 characters' };
      const doc = getDoc(db, input.docId);
      if (!doc) return { ok: false, error: DOC_NOT_FOUND };
      if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > doc.version) return { ok: false, error: VERSION_NOT_FOUND };
      const row = db
        .prepare('INSERT INTO doc_comments (docId, version, quote, text, author, sessionKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .get(doc.id, input.version, quote, text, 'owner', COMMENT_SESSION, clock().toISOString());
      const id = Number(row!.id);
      queueDelivery(id);
      // the delivery waits for the queue, so the stored comment has no event yet.
      const comment = listComments(db, doc.id).find((each) => each.id === id)!;
      return { ok: true, value: { ...comment, eventId: null, deliveredAt: null } };
    },
    start() {
      const waiting = db
        .prepare('SELECT c.id FROM doc_comments c LEFT JOIN doc_comment_deliveries d ON d.commentId = c.id WHERE d.commentId IS NULL ORDER BY c.id')
        .all();
      for (const row of waiting) queueDelivery(Number(row.id));
    },
  };
}

// the text of the system_event that carries a comment. it names the doc by its id and never by its title: the model
// wrote the title, maybe after reading outside text, and the event has no taint, because the comment is the owner's
// own text. newest is the newest version of the doc when the event is written.
export function commentEventText(comment: DocComment, newest: number): string {
  const later = newest > comment.version ? `; the doc is now at version ${newest}` : '';
  const parts = [`The owner commented on doc #${comment.docId}, version ${comment.version}${later}.`];
  if (comment.quote) {
    const quoted = comment.quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    parts.push(`The comment is about this part of the doc:\n${quoted}`);
  }
  parts.push(`The comment:\n${comment.text}`);
  parts.push('Read it with doc_read before you answer, and answer with doc_update or in the chat.');
  return parts.join('\n\n');
}
