import { useEffect, useState } from 'react';
import type { PersonSummary } from '../../../../src/dashboard/people-types';
import { api, useStream } from '../../api';
import './people.css';

// the person chip that other views use, for example the event details of the calendar and the chat. it shows the name
// of a person and opens the profile at #/people/:id. with only an email it asks GET /api/people/lookup for the person,
// and an address that is no person shows as plain text with the same look.
export interface PersonChipProps {
  email: string;
  // the name that the caller already has, for example from an attendee list. the chip shows it until the lookup ends.
  name?: string | null;
  // the id when the caller knows it, so the chip needs no lookup.
  personId?: number;
  size?: 'sm' | 'md';
}

// the letters of the avatar: the first letters of the first and the last word of a name, or the first letter of an
// address. a text with no letter or digit gives a question mark.
export function initialsOf(nameOrEmail: string): string {
  const text = nameOrEmail.trim();
  const isEmail = /^[^\s@]+@[^\s@]+$/.test(text);
  const source = isEmail ? text.split('@')[0]! : text;
  const words = source.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (!words.length) return '?';
  const first = (word: string) => Array.from(word).find((char) => /[\p{L}\p{N}]/u.test(char))!.toUpperCase();
  if (isEmail || words.length === 1) return first(words[0]!);
  return `${first(words[0]!)}${first(words.at(-1)!)}`;
}

// one lookup for each address, shared by every chip of the page, so twenty chips with one address make one request.
// a miss or a failure gives null, and the chip stays plain text. only a person that was found stays in the cache: a
// miss leaves it when its request ends, because a later poll can make the person, and an error before the sign-in
// can pass. a run of the agent can add people, so its end on the stream empties the cache.
const lookups = new Map<string, Promise<PersonSummary | null>>();

function lookup(email: string): Promise<PersonSummary | null> {
  const key = email.trim().toLowerCase();
  let found = lookups.get(key);
  if (!found) {
    const request = api<PersonSummary>(`/api/people/lookup?email=${encodeURIComponent(key)}`).then(
      (person) => person,
      () => null,
    );
    found = request.then((person) => {
      if (person === null && lookups.get(key) === found) lookups.delete(key);
      return person;
    });
    lookups.set(key, found);
  }
  return found;
}

// the tests start each case with an empty cache.
export function clearPersonLookups(): void {
  lookups.clear();
}

export function PersonChip({ email, name, personId, size = 'sm' }: PersonChipProps) {
  const [person, setPerson] = useState<PersonSummary | null | undefined>(undefined);
  // a chip that found no one asks again after a run of the agent, which may have made the person.
  const [round, setRound] = useState(0);
  useStream((message) => {
    if (message.kind !== 'run') return;
    lookups.clear();
    if (person === null) setRound((old) => old + 1);
  });
  useEffect(() => {
    if (personId !== undefined || !email.trim()) return;
    let current = true;
    void lookup(email).then((found) => current && setPerson(found));
    return () => {
      current = false;
    };
  }, [email, personId, round]);

  const shown = person?.name || name || person?.displayName || email;
  const body = (
    <>
      <span className="person-avatar" aria-hidden="true">
        {initialsOf(shown)}
      </span>
      <span className="person-chip-name">{shown}</span>
    </>
  );
  const className = `person-chip person-chip-${size}`;
  const id = personId ?? person?.id;
  if (id === undefined) {
    return (
      <span className={className} title={email}>
        {body}
      </span>
    );
  }
  const tip = [person?.primaryEmail ?? email, person?.organization].filter(Boolean).join(' · ');
  return (
    <a className={`${className} is-link`} href={`#/people/${id}`} aria-label={`Open ${shown}`} title={tip}>
      {body}
    </a>
  );
}
