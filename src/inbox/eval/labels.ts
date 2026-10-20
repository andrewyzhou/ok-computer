import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { insideFolder, realPath } from './dry.js';

// the labels of the quality check: what the owner says is right for some mails and subscriptions. the owner writes the
// file by hand, outside the repo, because it names real messages and merchants. the check uses it for the recall, the
// precision and the accuracy rates, which are null without it. the file looks like this:
//
//   {
//     "messages": { "personal:18c2f0a1b2c3d4e5": { "needsReply": true, "kind": "person", "due": "2026-10-24" } },
//     "subscriptions": { "personal:streamly": { "merchant": "Streamly", "amount": 15.49, "currency": "USD", "cadence": "monthly" } }
//   }
//
// a message key is <account>:<gmail message id>, and a subscription key is <account>:<merchant key>. due null says that
// the mail states no due date. a field that is left out has no label.

// a key is an alias, a colon and an id. the alias holds no colon.
const KEY = z.string().regex(/^[^:\s]+:\S+$/, 'give a key as <account>:<id>');
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'give a day as yyyy-mm-dd');

const MESSAGE = z.strictObject({
  needsReply: z.boolean().optional(),
  kind: z.enum(['person', 'list', 'automated']).optional(),
  due: DAY.nullable().optional(),
});

const SUBSCRIPTION = z.strictObject({
  merchant: z.string().min(1).max(200),
  amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'give the currency as three capital letters'),
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly', 'unknown']),
});

export const labelsSchema = z.strictObject({
  messages: z.record(KEY, MESSAGE).default({}),
  subscriptions: z.record(KEY, SUBSCRIPTION).default({}),
});

export type Labels = z.infer<typeof labelsSchema>;
export type MessageLabel = z.infer<typeof MESSAGE>;
export type SubscriptionLabel = z.infer<typeof SUBSCRIPTION>;

// the key of a message or a subscription in the labels.
export const labelKey = (account: string, id: string) => `${account}:${id}`;

// parseLabels checks the json of a labels file. the error names the keys and the fields that are wrong, which are ids
// and never mail text.
export function parseLabels(raw: unknown): Labels {
  const parsed = labelsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`the labels file is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// loadLabels reads a labels file. roots are the folders of the repo: a labels file inside one of them is refused, so
// the names of real messages and merchants never end up in a commit.
export function loadLabels(path: string, roots: readonly string[]): Labels {
  const file = realPath(resolve(path));
  for (const root of roots) {
    if (insideFolder(file, realPath(root))) throw new Error('keep the labels file outside the repo, because it names real messages and merchants');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`the labels file could not be read: ${(err as Error).message}`);
  }
  return parseLabels(raw);
}
