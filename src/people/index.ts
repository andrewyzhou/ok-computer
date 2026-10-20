// the read api of the people memory for the other parts of the app, for example the brief and the desk. it only reads:
// the polls fill the memory through the builder, and the agent writes notes through person_note. each function takes
// the clock time of the caller, because the counts and the upcoming meetings are split at now.
export { normalizeEmail } from './address.js';
export { findPersonByEmail, getPerson, searchPeople } from './store.js';
export type { PeoplePage, PersonMeetingView, PersonNoteView, PersonProfile, PersonSort, PersonSummary, PersonThreadView } from '../dashboard/people-types.js';
