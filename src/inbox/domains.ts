import { isIP } from 'node:net';

// the registrable domain of a host, which the newsletter keys and the receipt merchants share, so both read the same
// organisation from the same address. this module imports nothing of the inbox, so every part of it can use it.

// the public suffixes of two labels that real mail uses. a domain under one of them is registered one label lower,
// so "mail.shop.co.uk" belongs to "shop.co.uk" and not to "co.uk". the list is short on purpose: a suffix that is not
// in it only makes two senders of one such suffix share a domain, and the List-Id or the address still keeps them
// apart.
const TWO_LABEL_SUFFIXES = new Set(
  [
    'co.uk', 'ac.uk', 'org.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
    'co.jp', 'ac.jp', 'ne.jp', 'or.jp', 'go.jp',
    'co.nz', 'org.nz', 'net.nz', 'ac.nz', 'govt.nz',
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'edu.in',
    'co.kr', 'ac.kr', 'or.kr', 'go.kr',
    'com.cn', 'net.cn', 'org.cn', 'edu.cn', 'gov.cn',
    'com.hk', 'edu.hk', 'org.hk', 'gov.hk',
    'com.sg', 'edu.sg', 'gov.sg',
    'com.tw', 'edu.tw', 'org.tw',
    'com.mx', 'org.mx', 'edu.mx',
    'co.za', 'ac.za', 'org.za',
    'co.il', 'ac.il', 'org.il',
    'com.ar', 'com.tr', 'co.id', 'com.my', 'com.ph', 'com.vn', 'com.ua', 'co.th', 'ac.th', 'com.pk', 'com.ng', 'com.eg', 'com.sa',
  ],
);

// registrableDomain gives the domain under the public suffix of a host name, in lower case, from a short list of the
// common suffixes of two labels (co.uk, com.au, ac.uk, edu.au and the like). an ip address or a host with one label
// is given back as it is.
export function registrableDomain(host: string): string {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  if (isIP(name.replace(/^\[|\]$/g, ''))) return name;
  const labels = name.split('.');
  if (labels.length <= 2) return name;
  const two = labels.slice(-2).join('.');
  return TWO_LABEL_SUFFIXES.has(two) ? labels.slice(-3).join('.') : two;
}

// the registrable domain of a host that one organisation can own, or null for a host of one label and for a public
// suffix alone, such as "co.uk".
export function ownedDomain(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  const labels = name.split('.').filter(Boolean);
  if (labels.length < 2 || TWO_LABEL_SUFFIXES.has(labels.join('.'))) return null;
  return registrableDomain(labels.join('.'));
}
