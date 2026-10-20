import type { Delegation } from '../../../../src/dashboard/desk-types';

// the owner's form to create a delegation, or to edit one: title, details, next step, waiting on (name and email),
// due and follow-up times, and the status of an edit. it sends POST /api/desk/delegations or
// POST /api/desk/delegations/:id and shows the error text of a 400 or a 409 by the form. the work package "details
// panel and form" builds it.
export type DelegationFormProps =
  | { mode: 'create'; onDone: (delegation: Delegation) => void; onCancel: () => void }
  | { mode: 'edit'; delegation: Delegation; onDone: (delegation: Delegation) => void; onCancel: () => void };

export function DelegationForm(_props: DelegationFormProps) {
  return null;
}

// the create form in the details panel of the shell, for the page when the hash query has new=1.
export function NewDelegationPanel(_props: { onDone: (delegation: Delegation) => void; onCancel: () => void }) {
  return null;
}
