import type { gmail_v1 } from '@googleapis/gmail';
import type { GoogleApis } from '../google/accounts.js';
import { fromSdk, toGoogleError } from '../google/errors.js';
import { requestContext } from '../google/trace.js';
import { redact } from '../observability/redact.js';
import { cleanLine } from '../signals/store.js';
import { errorText } from '../tools/registry.js';

// the gmail reads that the inbox jobs share. each job runs them inside accounts.run, so the token, the retry and the
// request trace are the ones of the google integration. no function here sends mail: the inbox never sends.

// one page of messages.list holds at most 500 ids.
const PAGE = 500;
// a job reads many messages, a few at a time. the pace below limits the starts, so more workers only wait longer.
const PARALLEL = 3;

// gmail limits the reads of one user per minute, and every job of the app and the quality check share that limit. on
// the owner's accounts gmail refused the reads after about 150 messages.get calls in one minute. so the reads of one
// account start at most 2 a second after a first burst of 20, which stays under 140 in a minute, and a read that google
// limits anyway waits and tries again.
export interface GmailPace {
  burst: number;
  perSecond: number;
  // the waits before each new try of a read that google limited. the read fails after the last one.
  waits: readonly number[];
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

const abortError = () => new Error('the gmail read stopped, because the job was aborted');

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

const DEFAULT_PACE: GmailPace = { burst: 20, perSecond: 2, waits: [30_000, 60_000, 90_000, 120_000], sleep: sleepFor, now: () => Date.now() };
let pace: GmailPace = DEFAULT_PACE;

// the tests set a pace that never waits, or count the waits. a call without an argument puts the default back.
export function setGmailPaceForTests(next?: Partial<GmailPace>): void {
  pace = { ...DEFAULT_PACE, ...next };
  buckets.clear();
}

// the tokens of each account: a start takes one, and they come back at the pace. the account comes from the request
// context of accounts.run, and the gmail client stands in for it outside a run.
interface Bucket {
  tokens: number;
  at: number;
}
const buckets = new Map<string, Bucket>();
const clientKeys = new WeakMap<object, string>();
let clients = 0;

function keyOf(apis: GoogleApis): string {
  const account = requestContext.getStore()?.account;
  if (account) return `account:${account}`;
  let key = clientKeys.get(apis.gmail);
  if (!key) {
    key = `client:${++clients}`;
    clientKeys.set(apis.gmail, key);
  }
  return key;
}

// startSlot waits until the account may start one more read. the wait is the time that one token takes to come back,
// and the read takes that token.
async function startSlot(key: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  const now = pace.now();
  const bucket = buckets.get(key) ?? { tokens: pace.burst, at: now };
  bucket.tokens = Math.min(pace.burst, bucket.tokens + ((now - bucket.at) / 1000) * pace.perSecond);
  bucket.at = now;
  buckets.set(key, bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }
  const wait = Math.ceil(((1 - bucket.tokens) / pace.perSecond) * 1000);
  // the token is taken now, so the next read waits behind this one.
  bucket.tokens -= 1;
  await pace.sleep(wait, signal);
}

const isRate = (err: unknown) => fromSdk(err) && toGoogleError(err).kind === 'rate';

// paced runs one gmail call at the pace of its account. when google limits the rate, it waits and tries again, and it
// throws only after the last wait. any other error throws at once. an abort of the job ends the waits.
export async function paced<T>(apis: GoogleApis, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const key = keyOf(apis);
  for (let attempt = 0; ; attempt++) {
    await startSlot(key, signal);
    try {
      return await work();
    } catch (err) {
      const wait = pace.waits[attempt];
      if (!isRate(err) || wait === undefined || signal?.aborted) throw err;
      await pace.sleep(wait, signal);
    }
  }
}

export interface MessageRef {
  id: string;
  threadId: string;
}

// listMessages gives the ids of the messages that match a gmail search, newest first, at most max of them.
export async function listMessages(apis: GoogleApis, q: string, max: number, signal?: AbortSignal): Promise<MessageRef[]> {
  const refs: MessageRef[] = [];
  let pageToken: string | undefined;
  do {
    const token = pageToken;
    const { data } = await paced(apis, () => apis.gmail.users.messages.list({ userId: 'me', q, maxResults: Math.min(PAGE, max - refs.length), ...(token ? { pageToken: token } : {}) }), signal);
    for (const each of data.messages ?? []) if (each.id) refs.push({ id: each.id, threadId: each.threadId ?? each.id });
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken && refs.length < max);
  return refs.slice(0, max);
}

export type ReadFormat = { format: 'metadata'; headers: readonly string[] } | { format: 'full' };

// getMessages reads each message in the format that the job needs, a few at a time and at the pace of the account, in
// the order of the ids. a message that is gone (404 or 410) is left out. a read that google limits waits and tries
// again. any other error stops the read, because it can be about the account.
export async function getMessages(apis: GoogleApis, ids: readonly string[], options: ReadFormat & { signal?: AbortSignal }): Promise<gmail_v1.Schema$Message[]> {
  const out: Array<gmail_v1.Schema$Message | undefined> = new Array(ids.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < ids.length && !failed) {
      const index = next++;
      try {
        const { data } = await paced(
          apis,
          () =>
            apis.gmail.users.messages.get({
              userId: 'me',
              id: ids[index]!,
              format: options.format,
              ...(options.format === 'metadata' ? { metadataHeaders: [...options.headers] } : {}),
            }),
          options.signal,
        );
        out[index] = data;
      } catch (err) {
        if (!fromSdk(err)) {
          failed = true;
          throw err;
        }
        const error = toGoogleError(err);
        if (error.kind !== 'not_found' && error.kind !== 'gone') {
          failed = true;
          throw error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker));
  return out.filter((each): each is gmail_v1.Schema$Message => each !== undefined);
}

// the reason a read failed, in short words of the app. the text of a google error can name the project of the oauth
// client ("for consumer 'project_number:...'"), so it never reaches a note, the dashboard or the model.
const READ_WORDS: Record<string, string> = {
  auth: 'the account needs a new sign-in',
  client: 'google refused the oauth client',
  scope: 'the sign-in lacks a permission',
  rate: 'google limited the rate of reads',
  transient: 'google did not answer',
  not_found: 'google did not find a message',
  gone: 'a message is gone',
};

export function readError(err: unknown): string {
  if (!fromSdk(err)) return cleanLine(redact(errorText(err)), 200) || 'the read failed';
  const error = toGoogleError(err);
  // an error that the app wrote itself, such as a parked account, has no status and says what the owner must do.
  if (error.status === undefined && error.kind === 'auth') return cleanLine(redact(error.message), 200);
  return `${READ_WORDS[error.kind] ?? `google refused a read (${error.kind})`}${error.status ? `, status ${error.status}` : ''}`;
}

// the time of a message in gmail, from its internal date in milliseconds.
export function receivedAt(message: gmail_v1.Schema$Message): string {
  const ms = Number(message.internalDate);
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
}

export const isUnread = (message: gmail_v1.Schema$Message) => (message.labelIds ?? []).includes('UNREAD');
export const inInbox = (message: gmail_v1.Schema$Message) => (message.labelIds ?? []).includes('INBOX');
