import { Fragment } from 'react';

// the text helpers of the people views.

// guessedName reads a name from the local part of an address with a separator, for example "Jane Doe" for
// jane.doe@acme.com. it gives null for a local part without one, with a digit or with a plus tag. it is the same rule
// as guessedName of src/people/address.ts, which the agent tools use.
export function guessedName(email: string): string | null {
  const local = email.slice(0, email.lastIndexOf('@'));
  if (!/^[a-z]+([._][a-z]+)+$/i.test(local)) return null;
  return local
    .split(/[._]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Address shows an email with a break point after the @ and after each dot, so a narrow column breaks it between
// its parts and not in the middle of a word.
export function Address({ email }: { email: string }) {
  const parts = email.split(/(?<=[@.])/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}
