import type { Db } from '../db/index.js';
import type { GoogleConfig } from '../google/config.js';
import type { Tool } from '../tools/registry.js';
import type { PeopleStore } from './store.js';

// the agent tools of the people memory: person_lookup, people_search (both read only) and person_note (a write).
// the names and the profiles come from other people's mail headers, so the read tools mark their output as untrusted.

export const PEOPLE_READ_TOOLS = ['person_lookup', 'people_search'] as const;
export const PEOPLE_TOOLS = [...PEOPLE_READ_TOOLS, 'person_note'] as const;

export interface PeopleToolDeps {
  db: Db;
  // the default is the real store. the tests give a fake.
  store?: PeopleStore;
}

// createPeopleTools gives the three tools. the app registers them only with a google block, because the people
// memory fills from google. until the tools work package lands it gives no tool.
export function createPeopleTools(deps: PeopleToolDeps): Tool[] {
  void deps;
  return [];
}

// the people tool names of a session profile, like googleToolsFor: main gets all three when the google sessions
// include main, an automation gets all three with auto and only the read tools with auto-read, and any other profile
// gets none. until the tools work package lands it gives no name.
export function peopleToolsFor(config: Pick<GoogleConfig, 'sessions'>, profile: string): string[] {
  void config;
  void profile;
  return [];
}
