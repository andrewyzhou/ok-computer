import { openDb } from '../../src/db/index.js';
import type { AutonomyDomain, AutonomyLevel } from '../../src/policy/autonomy.js';
import { AutonomyError, changeLevel } from '../../src/policy/autonomy-store.js';

// one process of the race test of the trust ladder (test/autonomy-race.test.ts). it changes the levels of two domains
// many times as the owner on the dashboard or as the agent in chat, with no expected level, and prints the counts of
// its writes and of its refusals as json. other processes do the same at the same time on the same file.
const [path, seedText, roundsText] = process.argv.slice(2);
const db = openDb(path!);
let seed = Number(seedText);
// a small fixed generator, so a failing run can be repeated with the same seed.
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const domains: AutonomyDomain[] = ['mail_drafts', 'calendar_holds'];
const levels: AutonomyLevel[] = ['ask', 'review', 'auto'];
const counts = { written: 0, same: 0, refused: 0 };
for (let i = 0; i < Number(roundsText); i++) {
  const domain = domains[Math.floor(random() * domains.length)]!;
  const level = levels[Math.floor(random() * levels.length)]!;
  const owner = random() < 0.5;
  try {
    const change = changeLevel(
      db,
      owner ? { domain, level, actor: 'owner', via: 'dashboard' } : { domain, level, actor: 'agent', via: 'chat', runId: `run-${seedText}-${i}`, sessionKey: 'main' },
      new Date(Date.UTC(2026, 9, 20, 9, 0, 0, i)),
    );
    if (change) counts.written++;
    else counts.same++;
  } catch (err) {
    if (!(err instanceof AutonomyError)) throw err;
    counts.refused++;
  }
}
db.close();
process.stdout.write(JSON.stringify(counts));
