import type { gmail_v1 } from '@googleapis/gmail';
import type { GoogleApis } from '../google/accounts.js';
import { toGoogleError } from '../google/errors.js';

// the gmail reads that the inbox jobs share. each job runs them inside accounts.run, so the token, the retry and the
// request trace are the ones of the google integration. no function here sends mail: the inbox never sends.

// one page of messages.list holds at most 500 ids.
const PAGE = 500;
// a job reads the metadata of many messages. a few at a time keep it fast without a burst that google limits.
const PARALLEL = 8;

export interface MessageRef {
  id: string;
  threadId: string;
}

// listMessages gives the ids of the messages that match a gmail search, newest first, at most max of them.
export async function listMessages(apis: GoogleApis, q: string, max: number): Promise<MessageRef[]> {
  const refs: MessageRef[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await apis.gmail.users.messages.list({ userId: 'me', q, maxResults: Math.min(PAGE, max - refs.length), ...(pageToken ? { pageToken } : {}) });
    for (const each of data.messages ?? []) if (each.id) refs.push({ id: each.id, threadId: each.threadId ?? each.id });
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken && refs.length < max);
  return refs.slice(0, max);
}

// getMessages reads each message in the format that the job needs, a few at a time, in the order of the ids. a
// message that is gone (404 or 410) is left out. any other error stops the read, because it can be about the account.
export async function getMessages(
  apis: GoogleApis,
  ids: readonly string[],
  options: { format: 'metadata'; headers: readonly string[] } | { format: 'full' },
): Promise<gmail_v1.Schema$Message[]> {
  const out: Array<gmail_v1.Schema$Message | undefined> = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const index = next++;
      try {
        const { data } = await apis.gmail.users.messages.get({
          userId: 'me',
          id: ids[index]!,
          format: options.format,
          ...(options.format === 'metadata' ? { metadataHeaders: [...options.headers] } : {}),
        });
        out[index] = data;
      } catch (err) {
        const error = toGoogleError(err);
        if (error.kind !== 'not_found' && error.kind !== 'gone') throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker));
  return out.filter((each): each is gmail_v1.Schema$Message => each !== undefined);
}

// the time of a message in gmail, from its internal date in milliseconds.
export function receivedAt(message: gmail_v1.Schema$Message): string {
  const ms = Number(message.internalDate);
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
}

export const isUnread = (message: gmail_v1.Schema$Message) => (message.labelIds ?? []).includes('UNREAD');
export const inInbox = (message: gmail_v1.Schema$Message) => (message.labelIds ?? []).includes('INBOX');
