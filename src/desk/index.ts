// the public face of the desk. app.ts takes createDesk and installDeskJobs from here, and the brief of t1 reads the
// due and waiting delegations through listDue and listWaiting. the people profile reads the delegations that wait on a
// person through listWaitingOn. those three are a stable read api: they only read, they take the database, and they
// give Delegation rows (src/dashboard/desk-types.ts).
export { createDesk, deskAutomation, installDeskJobs, type Desk } from './desk.js';
export type { DeskDeps } from './context.js';
export { DESK_AUTO_TOOLS, DESK_MAIN_TOOLS } from './names.js';
export { DESK_INSTRUCTIONS } from './prompt.js';
export { getDelegation, listDue, listWaiting, listWaitingOn } from './store.js';
