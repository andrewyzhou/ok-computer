import type { EvalReport } from './metrics.js';

// the read-only quality check of the inbox jobs on the owner's real mail. it opens a copy of the database, reads the
// accounts through readOnlyGoogle of ../readonly.ts, runs the parts of each job, and fills an EvalReport. it never
// writes to the owner's database, never saves a draft, never asks for an approval and never sends a message: the
// owner messenger, the tool caller and the agent of its context refuse every call. the work package "eval" builds it.

export type EvalJob = 'digest' | 'subscriptions' | 'newsletters' | 'deadlines';

export interface EvalOptions {
  // the copy of the database, made with sqlite3 data/okc.sqlite ".backup <scratch>/okc.sqlite". the check refuses
  // the path of the live database.
  dbPath: string;
  // the config file to read. it is only read.
  configPath: string;
  // the accounts to check. the default is every account of the config.
  accounts?: string[];
  jobs: EvalJob[];
  // false runs only the checks in code, with no model call. true also runs the model calls of the jobs on the
  // configured slots, which costs money.
  models: boolean;
  // a json file of labels that the owner wrote, outside the repo (see labels.ts), or undefined.
  labelsPath?: string;
}

export async function runInboxEval(_options: EvalOptions): Promise<EvalReport> {
  throw new Error('not built: runInboxEval (work package eval)');
}
