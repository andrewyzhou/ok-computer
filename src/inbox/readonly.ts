import type { GoogleApis, GoogleAccounts } from '../google/accounts.js';
import type { OneClickResult } from '../google/unsubscribe.js';

// a read-only view of the google accounts, for the checks of the inbox jobs on the owner's real mail. the inbox code
// gets the apis through accounts.run, so a check gives it this view instead: each call of the gmail and calendar
// clients that is not on the list below throws before any request leaves, and a one-click post is refused. a check
// with this view cannot archive, label, unsubscribe, create an event or save a draft, also when a job tries to.

// the calls that only read. every other method of the clients is refused.
export const READ_CALLS: ReadonlySet<string> = new Set([
  'gmail.users.getProfile',
  'gmail.users.messages.list',
  'gmail.users.messages.get',
  'gmail.users.messages.attachments.get',
  'gmail.users.threads.list',
  'gmail.users.threads.get',
  'gmail.users.labels.list',
  'gmail.users.labels.get',
  'gmail.users.drafts.list',
  'gmail.users.drafts.get',
  'gmail.users.history.list',
  'calendar.events.list',
  'calendar.events.get',
  'calendar.calendarList.list',
  'calendar.calendarList.get',
  'calendar.calendars.get',
  'calendar.freebusy.query',
]);

// the error of a call that would change something. the inbox code turns it into a note of the run, as any error.
export class ReadOnlyRefused extends Error {
  constructor(readonly call: string) {
    super(`the read-only check refused ${call}, because it could change the account`);
  }
}

// guard wraps one object of a client. a method is looked up by its path from the client, so a call is allowed only
// when its whole path is on the list. the method runs on the real object, so the client keeps its own state.
function guard<T extends object>(target: T, path: string, refused: string[]): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof key === 'symbol') return value;
      const at = `${path}.${key}`;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          if (!READ_CALLS.has(at)) {
            refused.push(at);
            throw new ReadOnlyRefused(at);
          }
          return (value as (...input: unknown[]) => unknown).apply(object, args);
        };
      }
      if (value !== null && typeof value === 'object') return guard(value, at, refused);
      return value;
    },
    set() {
      throw new ReadOnlyRefused(`a change of ${path}`);
    },
    defineProperty() {
      throw new ReadOnlyRefused(`a change of ${path}`);
    },
  });
}

// readOnlyApis gives the read-only view of the apis of one account. refused collects the paths of the refused calls.
export function readOnlyApis(apis: GoogleApis, refused: string[] = []): GoogleApis {
  return { gmail: guard(apis.gmail, 'gmail', refused), calendar: guard(apis.calendar, 'calendar', refused) };
}

export interface ReadOnlyGoogle {
  accounts: GoogleAccounts;
  oneClick(target: string): Promise<OneClickResult>;
  // the calls that the view refused, in order, so a check can say what a job tried.
  refused: string[];
}

// readOnlyGoogle wraps the accounts of the app for a check. the inbox context takes it in place of the google object.
// a sign-in, a token import, a stored client and a needs-auth message all change state, so the view refuses them too.
export function readOnlyGoogle(accounts: GoogleAccounts): ReadOnlyGoogle {
  const refused: string[] = [];
  const refuse = (call: string) => {
    refused.push(call);
    return new ReadOnlyRefused(call);
  };
  return {
    refused,
    accounts: {
      aliases: accounts.aliases,
      unavailable: (alias) => accounts.unavailable(alias),
      // the wrapper is async, so a refused call becomes a rejection, as any error of a request.
      run: (alias, fn) => accounts.run(alias, async (apis) => fn(readOnlyApis(apis, refused))),
      hasClient: () => accounts.hasClient(),
      close: () => accounts.close(),
      alertPending: async () => {
        throw refuse('alertPending');
      },
      saveClient: async () => {
        throw refuse('saveClient');
      },
      beginSignIn: async () => {
        throw refuse('beginSignIn');
      },
      finishSignIn: async () => {
        throw refuse('finishSignIn');
      },
      importToken: async () => {
        throw refuse('importToken');
      },
    },
    async oneClick(target) {
      refused.push(`oneClick ${target}`);
      return { ok: false, refused: true, sent: false, text: 'the read-only check never unsubscribes' };
    },
  };
}
