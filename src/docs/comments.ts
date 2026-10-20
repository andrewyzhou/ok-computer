import type { Result } from '../config/load.js';
import type { Db } from '../db/index.js';
import type { DocComment } from '../dashboard/docs-types.js';
import type { Logger } from '../observability/logger.js';
import type { RunQueue } from '../sessions/queue.js';
import type { Clock } from '../time.js';
import { NotBuilt } from './not-built.js';

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

export function createDocComments(deps: DocCommentsDeps): DocComments {
  void deps;
  return {
    add() {
      throw new NotBuilt('the doc comments');
    },
    // the scaffold sends nothing, so the start of the app does not fail before the comments package lands.
    start() {},
  };
}

// the text of the system_event that carries a comment. it names the doc by its id and never by its title: the model
// wrote the title, maybe after reading outside text, and the event has no taint, because the comment is the owner's
// own text. newest is the newest version of the doc when the event is written.
export function commentEventText(comment: DocComment, newest: number): string {
  void comment;
  void newest;
  throw new NotBuilt('commentEventText');
}
