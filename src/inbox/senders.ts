import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { gmail_v1 } from '@googleapis/gmail';
import type { UnsubscribeMethod } from '../dashboard/types.js';
import { fromAddress as parseFrom, header } from '../google/mime.js';
import { unsubscribeTargets } from '../google/unsubscribe.js';
import { cleanLine } from '../signals/store.js';
import { httpsLink } from './actions.js';

// the grouping of the newsletter sweep on real mail. a group must never hold two senders: a List-Id that a platform
// shares between its customers, a no-reply address that sends for many organisers, and a sender that changes its
// display name must each end up right. senderOf and unsubscribeOf of newsletters.ts use this module.

// the identity of the sender of one list mail. senderKey is the key of inbox_senders: at most 200 characters, in lower
// case, and stable across sweeps, so a row that the owner kept or unsubscribed keeps its state.
export interface SenderIdentity {
  senderKey: string;
  listId: string | null;
  fromAddress: string;
  // the registrable domain of the from address, for example "example.co.uk" for "news@mail.example.co.uk".
  fromDomain: string;
  displayName: string | null;
}

// the longest list id and sender key that a row keeps. the sender writes the List-Id header.
export const KEY_LIMIT = 200;

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

// the quotes of a quoted name are not part of the name.
const unquoted = (text: string) => cleanLine(text.replace(/"/g, ''), 200);

// the name of an organiser in a display name of the form "X via Y", where Y is the platform that sends for X. the last
// "via" counts, because the platform adds its own name at the end.
const VIA = /^(.+)\s+via\s+\S.*$/i;

// a slug in lower case: every run of characters that are not letters or digits becomes one "-". letters of every
// script count, so two organisers with names in another script keep apart.
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

// "#" joins the parts of a key. a list id, a domain or an address of real mail never holds one, but the sender writes
// these headers, so a "#" in them is escaped: a sender cannot write a list id or an address that gives the key of
// another sender. a slug and a domain never look alike, because a domain has a dot and a slug has none.
const escaped = (text: string) => text.replace(/#/g, '%23');

// fitKey keeps a key at KEY_LIMIT characters. a longer key keeps its start and ends with a short hash of the whole
// key, so two long keys with the same start stay apart, and the same key gives the same result in every sweep.
export function fitKey(key: string): string {
  if (key.length <= KEY_LIMIT) return key;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return `${key.slice(0, KEY_LIMIT - hash.length - 1)}~${hash}`;
}

// senderIdentityOf gives the identity of the sender of a list mail, or undefined for a mail that is not list mail (no
// List-Id and no List-Unsubscribe) or has no from address.
export function senderIdentityOf(message: gmail_v1.Schema$Message): SenderIdentity | undefined {
  const listHeader = header(message, 'List-Id');
  if (!listHeader && !header(message, 'List-Unsubscribe')) return undefined;
  const from = header(message, 'From');
  const fromAddress = parseFrom(from);
  if (!fromAddress) return undefined;
  const fromDomain = registrableDomain(fromAddress.slice(fromAddress.lastIndexOf('@') + 1));
  const bracket = /<([^<>]*)>/.exec(listHeader);
  const listId = (bracket ? bracket[1]! : listHeader).trim().toLowerCase().slice(0, KEY_LIMIT).trim() || null;
  // the name of the from header is the text before its address. the list phrase is the text before the list id.
  const fromName = unquoted(/^(.*)<[^<>]*>\s*$/.exec(from)?.[1] ?? '');
  const listName = bracket ? unquoted(listHeader.slice(0, bracket.index)) : '';
  const displayName = fromName || listName || null;
  let senderKey: string;
  if (listId) {
    // a list id is a dotted name, so its last labels name the domain of the list. a platform that puts one list id on
    // the mail of many customers sends it from the domain of each customer, so the from domain keeps them apart. a
    // list of the sender's own domain keeps the key of phase 5.
    senderKey = registrableDomain(listId) === fromDomain && !listId.includes('#') ? listId : fitKey(`${escaped(listId)}#${escaped(fromDomain)}`);
  } else {
    // a shared address that sends for many organisers names each one as "X via Y".
    const organiser = VIA.exec(fromName)?.[1];
    const part = organiser ? slug(organiser) : '';
    senderKey = fitKey(part ? `${escaped(fromAddress)}#${part}` : escaped(fromAddress));
  }
  return { senderKey, listId, fromAddress, fromDomain, displayName };
}

// the key that phase 5 gave the same mail: the list id, else the from address. a row of phase 5 has this key.
export const phase5KeyOf = (identity: SenderIdentity): string => identity.listId ?? identity.fromAddress;

// the unsubscribe of one message. url is always one of the targets that unsubscribeTargets of src/google/unsubscribe.ts
// gives for the same header, because the tool compares them at run time.
export interface UnsubscribeChoice {
  method: UnsubscribeMethod;
  url: string | null;
}

// unsubscribeChoiceOf reads List-Unsubscribe and List-Unsubscribe-Post of a message. it handles several targets in
// any order, folded header lines, spaces in the angle brackets, an http target (never used), a mailto target with a
// subject, a post header in another case, and a header without angle brackets. one_click needs an https target and
// List-Unsubscribe-Post (rfc 8058), https is an https target without it, and mailto is a mailto target only.
export function unsubscribeChoiceOf(message: gmail_v1.Schema$Message): UnsubscribeChoice {
  // unsubscribeTargets gives only https and mailto targets, trimmed, in their order. the url is one of them as it is.
  const targets = unsubscribeTargets(header(message, 'List-Unsubscribe'));
  // a target with a space or one that does not parse is text, not a link, so it is never offered.
  const https = targets.find((target) => /^https:/i.test(target) && httpsLink(target) !== null);
  if (https) return { method: /List-Unsubscribe=One-Click/i.test(header(message, 'List-Unsubscribe-Post')) ? 'one_click' : 'https', url: https };
  const mailto = targets.find((target) => /^mailto:/i.test(target));
  if (mailto) return { method: 'mailto', url: mailto };
  return { method: 'none', url: null };
}
