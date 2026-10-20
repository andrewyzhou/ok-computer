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
  const out: ObservedAddress[] = [];
  const seen = new Set<string>();
  for (const part of splitParts(header)) {
    const parsed = parsePart(part);
    if (!parsed || seen.has(parsed.email)) continue;
    seen.add(parsed.email);
    out.push(parsed);
  }
  return out;
}

// splitParts cuts a header at each comma or semicolon that is outside double quotes, angle brackets and comments.
// the name of a group ("team:") is dropped at its colon, and the semicolon at the end of a group ends a part.
function splitParts(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  let depth = 0;
  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;
    if (char === '\\' && (quoted || depth > 0) && i + 1 < header.length) {
      current += char + header[++i];
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      current += char;
    } else if (depth > 0) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      current += char;
    } else if (angle) {
      if (char === '>') angle = false;
      current += char;
    } else if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === '(') {
      depth = 1;
      current += char;
    } else if (char === '<') {
      angle = true;
      current += char;
    } else if (char === ',' || char === ';') {
      parts.push(current);
      current = '';
    } else if (char === ':') {
      // the text before the colon is the name of a group, never an address.
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

// parsePart reads one address: "Name <a@b.c>", "\"Last, First\" <a@b.c>", "a@b.c", "<a@b.c>" or "a@b.c (Name)".
function parsePart(part: string): ObservedAddress | null {
  let display = '';
  let plain = '';
  let quoted = '';
  let comment = '';
  let angleAddress: string | null = null;
  for (let i = 0; i < part.length; i++) {
    const char = part[i]!;
    if (char === '"') {
      // a quoted name. a backslash keeps the next character as it is.
      let text = '';
      for (i++; i < part.length && part[i] !== '"'; i++) {
        if (part[i] === '\\' && i + 1 < part.length) i++;
        text += part[i];
      }
      display += ` ${text} `;
      quoted += ` ${text} `;
    } else if (char === '(') {
      let text = '';
      let depth = 1;
      for (i++; i < part.length; i++) {
        const inner = part[i]!;
        if (inner === '\\' && i + 1 < part.length) {
          text += part[++i];
          continue;
        }
        if (inner === '(') depth++;
        else if (inner === ')' && --depth === 0) break;
        text += inner;
      }
      comment += ` ${text} `;
    } else if (char === '<') {
      const end = part.indexOf('>', i);
      angleAddress = part.slice(i + 1, end === -1 ? part.length : end);
      i = end === -1 ? part.length : end;
    } else {
      display += char;
      plain += char;
    }
  }
  let email: string | null;
  let name: string;
  if (angleAddress !== null) {
    email = normalizeEmail(angleAddress);
    name = display;
  } else {
    // without angle brackets the word with a valid address is the address, and the quoted text and the other words
    // are the name.
    const words = plain.trim().split(/\s+/);
    const index = words.findIndex((word) => normalizeEmail(word) !== null);
    if (index === -1) return null;
    email = normalizeEmail(words[index]!);
    name = [quoted, ...words.slice(0, index), ...words.slice(index + 1)].join(' ');
  }
  if (!email) return null;
  const named = cleanName(name, email);
  if (named === null) return { email, name: cleanName(comment, email) };
  const note = comment.replace(/\s+/g, ' ').trim();
  return note ? { email, name: named, comment: note } : { email, name: named };
}

// cleanName takes the quotes off a display name and folds its spaces. it gives null for an empty name and for a
// name that is only the address again. the builder uses it for the names of calendar attendees too.
export function cleanName(raw: string | null | undefined, email: string): string | null {
  let name = (raw ?? '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const stripped = name.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1').trim();
    if (stripped === name) break;
    name = stripped;
  }
  if (!name || name.toLowerCase() === email.toLowerCase()) return null;
  return name;
}

// the domains where anyone can have an address. the families of country domains are matched by their first label.
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'mail.com',
  'qq.com',
  '163.com',
  '126.com',
  'fastmail.com',
  'hey.com',
  'zoho.com',
  'msn.com',
  'ymail.com',
  'rocketmail.com',
  'mail.ru',
  'web.de',
  'tutanota.com',
  'naver.com',
  'comcast.net',
  'att.net',
  'verizon.net',
  'sbcglobal.net',
]);
const PERSONAL_FAMILIES = /^(yahoo|gmx|yandex|outlook|hotmail|live)(\.[a-z]{2,3}){1,2}$/;

export function isPersonalDomain(domain: string): boolean {
  const lower = domain.trim().toLowerCase();
  return PERSONAL_DOMAINS.has(lower) || PERSONAL_FAMILIES.test(lower);
}

// the public suffixes of two labels that the registrable part of a domain keeps under a third label.
const TWO_PART_SUFFIXES = new Set(['co.uk', 'ac.uk', 'org.uk', 'gov.uk', 'com.au', 'edu.au', 'co.jp', 'ac.jp', 'co.nz', 'com.br', 'co.in', 'com.cn', 'com.sg', 'co.kr']);

export function organizationOf(domain: string): Organization | null {
  const lower = domain.trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(lower) || isPersonalDomain(lower)) return null;
  const labels = lower.split('.');
  const keep = TWO_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  if (labels.length < keep) return null;
  const registrable = labels.slice(-keep).join('.');
  if (isPersonalDomain(registrable)) return null;
  const first = labels[labels.length - keep]!;
  return { name: organizationName(first), domain: registrable };
}

// the name of an organization from its domain label: each part between hyphens with a capital, for example
// "Globex Labs" for globex-labs. the label has no word breaks of its own, so "acmeworks" stays one word.
function organizationName(label: string): string {
  return label
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// guessedName reads a name from the local part of an address with a separator, for example "Jane Doe" for
// jane.doe@acme.com or jane_doe@acme.com. it gives null for a local part without one (jdoe), with a digit, or with a
// plus tag, because then the guess is more often wrong than right. the views and the tools show it for a person
// without a name, and the address stays the key.
export function guessedName(email: string): string | null {
  const local = email.slice(0, email.lastIndexOf('@'));
  if (!/^[a-z]+([._][a-z]+)+$/i.test(local)) return null;
  return local
    .split(/[._]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
