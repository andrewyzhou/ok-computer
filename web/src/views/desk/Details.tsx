import './details.css';

// the details panel of one delegation: its facts, its links (runs, docs, threads, events), its nudge drafts, its
// history oldest first, and the owner's actions (edit, a status change, a note). it renders the DetailsPanel of the
// shell itself and loads GET /api/desk/delegations/:id. the work package "details panel and form" builds it.
export interface DelegationPanelProps {
  id: number;
  onClose: () => void;
  // a change on the panel calls this, so the board loads again.
  onChanged: () => void;
}

export function DelegationPanel(_props: DelegationPanelProps) {
  return null;
}
