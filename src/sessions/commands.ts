import type { Button } from '../channels/types.js';
import type { Db } from '../db/index.js';
import { formatGoal, listGoals } from '../goals/store.js';
import { localDay, localTime, type Clock } from '../time.js';

export interface Card {
  text: string;
  buttons?: Button[][];
  details?: string;
}

// the main run that runs now, as the router knows it.
export interface RunState {
  runningSince?: Date;
  // the tools that the run calls now.
  tools?: string;
}

export interface CommandDeps {
  db: Db;
  clock: Clock;
  timeZone: string;
  dashboardUrl: string;
  approvalCard: (id: number) => Card;
}

const MAX_CARDS = 10;

// these commands read the database and answer in code. they need no model call, and they work while a run is busy.
// a command name that is not here goes to the model as text.
export function createCommands(deps: CommandDeps) {
  const { db, clock, timeZone } = deps;
  const pendingIds = () =>
    db
      .prepare("SELECT id FROM approvals WHERE status = 'pending' ORDER BY id")
      .all()
      .map((row) => Number(row.id));

  return (text: string, state: RunState): Card[] | undefined => {
    switch (text.trim().toLowerCase()) {
      case '/status': {
        const run = state.runningSince
          ? `I am working on a reply since ${localTime(state.runningSince, timeZone)}. /stop stops it.`
          : 'Nothing runs now.';
        const pending = pendingIds().length;
        const approvals = pending ? `${pending} approval${pending === 1 ? '' : 's'} wait${pending === 1 ? 's' : ''} for you. /approvals shows them.` : 'No approval waits for you.';
        return [{ text: `${run}\n${approvals}\nDashboard: ${deps.dashboardUrl}` }];
      }
      case '/goals': {
        const goals = listGoals(db, localDay(clock(), timeZone));
        return [{ text: goals.length ? `Today's goals:\n${goals.map((goal) => formatGoal(goal, timeZone)).join('\n')}` : 'No goals for today yet.' }];
      }
      case '/approvals': {
        const ids = pendingIds();
        if (!ids.length) return [{ text: 'No approval waits for you.' }];
        const cards = ids.slice(0, MAX_CARDS).map(deps.approvalCard);
        return ids.length > MAX_CARDS ? [...cards, { text: `${ids.length - MAX_CARDS} more wait on the dashboard: ${deps.dashboardUrl}` }] : cards;
      }
      case '/dashboard':
        return [{ text: deps.dashboardUrl }];
      default:
        return undefined;
    }
  };
}
