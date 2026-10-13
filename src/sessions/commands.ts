import type { Button } from '../channels/types.js';
import type { LoginCodes } from '../dashboard/login.js';
import type { Db } from '../db/index.js';
import { formatGoal, listGoals } from '../goals/store.js';
import { headOf } from '../text.js';
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
  // the owner messages that wait for the run.
  queued?: number;
  // an approved call or an automation holds the main session, so a new message waits for it.
  held?: boolean;
  // the run ended, and the router sends its reply now.
  replying?: boolean;
}

const NO_LINK = (url: string) =>
  [
    `The dashboard: ${url}`,
    'A sign-in link for another device needs DASHBOARD_TOKEN in .env and dashboard.publicUrl in okc.config.json, then a restart.',
    'docs/setup/tailscale.md shows the steps.',
  ].join('\n');

export interface CommandDeps {
  db: Db;
  clock: Clock;
  timeZone: string;
  dashboardUrl: string;
  approvalCard: (id: number) => Card;
  // signInLink gives the answer to /dashboard, normally a link to the public dashboard with a new code. without it,
  // /dashboard says what to set.
  signInLink?: () => string;
  // the state of each integration, for /status.
  integrations?: () => Array<{ id: string; state: { status: string } }>;
}

const MAX_CARDS = 10;

// a code works only in the dashboard of this process. when that dashboard did not start, for example because an older
// process holds its port, a link would only fail.
export const signInLink = (publicUrl: string, codes: LoginCodes, port: number) => () => {
  const code = codes.issue();
  if (code === undefined) {
    return `The dashboard did not start, so a sign-in link would not work. Another program, for example an older copy of the app, can hold port ${port}. The log says why.`;
  }
  return `${new URL('/login', publicUrl).href}?code=${code}\nThe link signs you in one time and works for 5 minutes.`;
};

// these commands read the database and answer in code. they need no model call, and they work while a run is busy.
// a command name that is not here goes to the model as text.
export function createCommands(deps: CommandDeps) {
  const { db, clock, timeZone } = deps;
  const pendingIds = () =>
    db
      .prepare("SELECT id FROM approvals WHERE status = 'pending' ORDER BY id")
      .all()
      .map((row) => Number(row.id));
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

  const status = (state: RunState) => {
    const lines: string[] = [];
    if (state.runningSince) {
      const minutes = Math.floor((clock().getTime() - state.runningSince.getTime()) / 60_000);
      lines.push(`I am working on a reply since ${localTime(state.runningSince, timeZone)} (${minutes} min). /stop stops it.`);
      if (state.tools) lines.push(`Running now: ${state.tools}.`);
    } else if (state.replying) lines.push('Sending the reply.');
    else if (state.held) lines.push('An approved call or an automation runs now. /stop cannot stop it, and the dashboard shows it.');
    else lines.push('Nothing runs now.');
    if (state.queued) lines.push(`${plural(state.queued, 'message waits', 'messages wait')} for the reply.`);
    // a memory flush or an automation also runs in the main session, and a flush starts inside the run of a reply. so
    // only a run for an owner message is a reply.
    const last = db
      .prepare("SELECT status, error, endedAt FROM runs WHERE sessionKey = 'main' AND trigger = 'message' AND status != 'running' ORDER BY startedAt DESC LIMIT 1")
      .get();
    if (last) {
      const at = last.endedAt ? ` at ${localTime(new Date(String(last.endedAt)), timeZone)}` : '';
      const error = last.error ? `: ${headOf(String(last.error), 200)}` : '';
      lines.push(`Last reply: ${String(last.status)}${at}${error}.`);
    }
    const pending = pendingIds().length;
    lines.push(pending ? `${plural(pending, 'approval waits', 'approvals wait')} for you. /approvals shows them.` : 'No approval waits for you.');
    const integrations = deps.integrations?.() ?? [];
    if (integrations.length) lines.push(`Integrations: ${integrations.map((each) => `${each.id} ${each.state.status.replaceAll('_', ' ')}`).join(', ')}.`);
    lines.push(`Dashboard: ${deps.dashboardUrl}`);
    return lines.join('\n');
  };

  return (text: string, state: RunState): Card[] | undefined => {
    switch (text.trim().toLowerCase()) {
      case '/status':
        return [{ text: status(state) }];
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
        return [{ text: deps.signInLink ? deps.signInLink() : NO_LINK(deps.dashboardUrl) }];
      default:
        return undefined;
    }
  };
}
