import type { Db } from '../db/index.js';
import type { Tool } from '../tools/registry.js';

// the tools of the docs (phase 6 t4). the app registers them with one line, and the session lists name them through
// names.ts, so no other file needs a change when a tool is added here. names.ts imports nothing, so the policy and
// the session lists can import it.

export { DOC_READ_TOOLS, DOC_TOOLS, DOC_WRITE_TOOLS } from './names.js';

export interface DocToolDeps {
  db: Db;
  // the address of the dashboard that a chat link uses, for example http://127.0.0.1:4318 or the public url. a tool
  // result gives the link of a doc as `${dashboardUrl}/#/docs/<id>`.
  dashboardUrl: string;
}

// the tools package fills this list. until then the app has no doc tools, so no tool list of a session changes.
export function createDocTools(deps: DocToolDeps): Tool[] {
  void deps;
  return [];
}
