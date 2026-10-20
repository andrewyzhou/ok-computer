// the person chip that other views use, for example the event details of the calendar and the chat. it shows the name
// of a person and opens the profile at #/people/:id. with only an email it asks GET /api/people/lookup for the person,
// and an address that is no person shows as plain text. the views work package builds it; until then it shows the
// name or the email as text.
export interface PersonChipProps {
  email: string;
  // the name that the caller already has, for example from an attendee list. the chip shows it until the lookup ends.
  name?: string | null;
  // the id when the caller knows it, so the chip needs no lookup.
  personId?: number;
  size?: 'sm' | 'md';
}

export function PersonChip({ email, name }: PersonChipProps) {
  return <span className="person-chip">{name || email}</span>;
}
