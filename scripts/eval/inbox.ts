// the read-only quality check of the inbox jobs on the owner's real mail. it prints counts and rates, never mail text.
//
//   sqlite3 data/okc.sqlite ".backup <scratch>/okc.sqlite"
//   npx tsx scripts/eval/inbox.ts --db <scratch>/okc.sqlite [--config okc.config.json] [--account <alias>]...
//     [--job digest|subscriptions|newsletters|deadlines]... [--models] [--labels <file>] [--names] [--json]
//
// without --job it runs every job. without --models it makes no model call. --names adds the merchant names of the
// subscriptions, which come from mail, so they are off by default. it exits with 1 when a bar is not met, and with 2
// when it cannot start, for example on the path of the live database.

import { parseArgs } from 'node:util';
import { formatReport, scrub } from '../../src/inbox/eval/metrics.js';
import { runInboxEval, type EvalJob } from '../../src/inbox/eval/run.js';

const JOBS: EvalJob[] = ['digest', 'subscriptions', 'newsletters', 'deadlines'];

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    config: { type: 'string', default: 'okc.config.json' },
    account: { type: 'string', multiple: true },
    job: { type: 'string', multiple: true },
    models: { type: 'boolean', default: false },
    labels: { type: 'string' },
    names: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

if (!values.db) {
  console.error('give the copy of the database with --db <path>');
  process.exit(2);
}
const jobs = (values.job ?? JOBS) as EvalJob[];
const unknown = jobs.filter((each) => !JOBS.includes(each));
if (unknown.length) {
  console.error(`give each --job as one of: ${JOBS.join(', ')}`);
  process.exit(2);
}

let report: Awaited<ReturnType<typeof runInboxEval>>;
try {
  report = await runInboxEval({
    dbPath: values.db,
    configPath: values.config,
    jobs,
    models: values.models,
    names: values.names,
    ...(values.account ? { accounts: values.account } : {}),
    ...(values.labels ? { labelsPath: values.labels } : {}),
  });
} catch (err) {
  // an error can quote a link or an address, so it is scrubbed as the report is.
  console.error(scrub(err instanceof Error ? err.message : String(err)));
  process.exit(2);
}
console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.failures.length ? 1 : 0);
