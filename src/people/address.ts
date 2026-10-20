import { notBuilt } from './not-built.js';
import type { ObservedAddress, Organization } from './types.js';

// the address rules of the people memory. the store, the tools and the builder all use normalizeEmail, so one address
// is one key everywhere.

// an address is kept in lower case and without spaces around it. the local part is not changed in any other way: dots
// and plus tags are kept, because only gmail ignores them and a wrong merge joins two people.
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  if (email.length > 254 || /[\s<>(),;:"\\[\]]/.test(email)) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const domain = email.slice(at + 1);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return email;
}

// the domain of a normalized address, for example acme.com for jane@acme.com.
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

// parseAddressList reads a From, To or Cc header: "Jane Doe <jane@acme.com>, \"Doe, John\" <john@acme.com>, x@y.org".
// it keeps the commas inside quotes and comments, drops group names ("team: a@b.c, d@e.f;"), decodes nothing (gmail
// gives the header already decoded), and leaves out each part that has no valid address. a name that equals the
// address, or that is empty after the quotes are taken off, becomes null. the order of the header is kept, and an
// address that comes twice is kept once, with the first name that it had.
export function parseAddressList(header: string): ObservedAddress[] {
  void header;
  return notBuilt('parseAddressList');
}

// true for a domain where anyone can have an address, so the domain names no organization: gmail.com,
// googlemail.com, outlook.com, hotmail.com, live.com, msn.com, yahoo.com (and its country domains), icloud.com,
// me.com, mac.com, aol.com, proton.me, protonmail.com, pm.me, gmx.*, mail.com, yandex.*, qq.com, 163.com, fastmail.com,
// hey.com, zoho.com and the like.
export function isPersonalDomain(domain: string): boolean {
  void domain;
  return notBuilt('isPersonalDomain');
}

// organizationOf gives the organization of an address domain, or null for a personal domain. the domain is cut to its
// registrable part (mail.eu.acme.com gives acme.com, and the two-part suffixes such as co.uk, ac.uk, com.au and
// co.jp keep three labels), and the name is the first label of it in title case (acme.com gives "Acme",
// berkeley.edu gives "Berkeley").
export function organizationOf(domain: string): Organization | null {
  void domain;
  return notBuilt('organizationOf');
}
