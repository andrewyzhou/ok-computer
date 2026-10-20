import type { gmail_v1 } from '@googleapis/gmail';
import type { UnsubscribeMethod } from '../../dashboard/types.js';

// the cases of the newsletter grouping and of the unsubscribe header that the shared corpus does not hold. the mail is
// made up and uses example domains, in the shapes that real list mail has.

// a message as gmail gives it in format metadata, with only the headers that a case names.
export const headersMessage = (headers: Record<string, string>, id = 'm'): gmail_v1.Schema$Message => ({
  id,
  payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
});

// two mails, and whether they come from the same sender.
export interface GroupCase {
  name: string;
  a: Record<string, string>;
  b: Record<string, string>;
  same: boolean;
}

const LONG_ID = `${'very-long-list-name-'.repeat(12)}.lists.platform.example`;

export const GROUP_CASES: GroupCase[] = [
  {
    name: 'a list whose from domain is a subdomain of the list domain',
    a: { From: 'Shop <news@mail.shop.example>', 'List-Id': 'Shop News <news.shop.example>' },
    b: { From: 'Shop <offers@shop.example>', 'List-Id': 'Shop News <news.shop.example>' },
    same: true,
  },
  {
    name: 'a university list with the from of a professor and of a teaching assistant',
    a: { From: 'Dana Rivera <rivera@cs.school.example.edu>', 'List-Id': '<cs101.lists.school.example.edu>' },
    b: { From: 'Lee Park <lee.park@school.example.edu>', 'List-Id': '<cs101.lists.school.example.edu>' },
    same: true,
  },
  {
    name: 'the same newsletter from two addresses on one domain of a two label suffix',
    a: { From: 'Weekly <weekly@shop.co.uk>', 'List-Id': '<a9.list-id.mailplatform.example>' },
    b: { From: 'Weekly <hello@mail.shop.co.uk>', 'List-Id': '<a9.list-id.mailplatform.example>' },
    same: true,
  },
  {
    name: 'two shops under one two label suffix with a shared list id',
    a: { From: 'Weekly <weekly@shop.co.uk>', 'List-Id': '<a9.list-id.mailplatform.example>' },
    b: { From: 'Weekly <weekly@other.co.uk>', 'List-Id': '<a9.list-id.mailplatform.example>' },
    same: false,
  },
  {
    name: 'a shared no-reply address with a "via" name in another case',
    a: { From: '"Jazz Night VIA Tickets" <noreply@tickets.example>', 'List-Unsubscribe': '<https://tickets.example/u/1>' },
    b: { From: 'Jazz Night via Tickets <noreply@tickets.example>', 'List-Unsubscribe': '<https://tickets.example/u/2>' },
    same: true,
  },
  {
    name: 'organisers with names in another script',
    a: { From: '音乐会 via Tickets <noreply@tickets.example>', 'List-Unsubscribe': '<https://tickets.example/u/1>' },
    b: { From: '书展 via Tickets <noreply@tickets.example>', 'List-Unsubscribe': '<https://tickets.example/u/2>' },
    same: false,
  },
  {
    name: 'a long list id on two from domains',
    a: { From: 'A <a@first.example>', 'List-Id': `<${LONG_ID}>` },
    b: { From: 'B <b@second.example>', 'List-Id': `<${LONG_ID}>` },
    same: false,
  },
];

// one List-Unsubscribe header and what unsubscribeChoiceOf should give.
export interface UnsubscribeCase {
  name: string;
  headers: Record<string, string>;
  method: UnsubscribeMethod;
  url: string | null;
}

export const UNSUBSCRIBE_CASES: UnsubscribeCase[] = [
  {
    name: 'mailto first, then https, with the post header',
    headers: { 'List-Unsubscribe': '<mailto:u@shop.example?subject=unsubscribe>, <https://shop.example/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    method: 'one_click',
    url: 'https://shop.example/u/1',
  },
  {
    name: 'https first, then mailto, without the post header',
    headers: { 'List-Unsubscribe': '<https://shop.example/u/1>, <mailto:u@shop.example>' },
    method: 'https',
    url: 'https://shop.example/u/1',
  },
  {
    name: 'two https targets: the first one counts',
    headers: { 'List-Unsubscribe': '<https://shop.example/u/1>,<https://shop.example/u/2>' },
    method: 'https',
    url: 'https://shop.example/u/1',
  },
  {
    name: 'a folded header',
    headers: { 'List-Unsubscribe': '<mailto:u@shop.example>,\r\n\t<https://shop.example/u/1?a=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    method: 'one_click',
    url: 'https://shop.example/u/1?a=1',
  },
  {
    name: 'spaces inside the angle brackets',
    headers: { 'List-Unsubscribe': '<  https://shop.example/u/1  >' },
    method: 'https',
    url: 'https://shop.example/u/1',
  },
  {
    name: 'a post header in another case',
    headers: { 'list-unsubscribe': '<https://shop.example/u/1>', 'LIST-UNSUBSCRIBE-POST': 'list-unsubscribe=one-click' },
    method: 'one_click',
    url: 'https://shop.example/u/1',
  },
  {
    name: 'a header without angle brackets',
    headers: { 'List-Unsubscribe': 'https://shop.example/u/1, mailto:u@shop.example' },
    method: 'none',
    url: null,
  },
  {
    name: 'an http target is never chosen, so the mailto counts',
    headers: { 'List-Unsubscribe': '<http://shop.example/u/1>, <mailto:u@shop.example?subject=stop%20please>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    method: 'mailto',
    url: 'mailto:u@shop.example?subject=stop%20please',
  },
  {
    name: 'an http target alone',
    headers: { 'List-Unsubscribe': '<http://shop.example/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    method: 'none',
    url: null,
  },
  {
    name: 'a link with an html entity stays as the header writes it',
    headers: { 'List-Unsubscribe': '<https://shop.example/u?a=1&amp;b=2>' },
    method: 'https',
    url: 'https://shop.example/u?a=1&amp;b=2',
  },
  {
    name: 'an https target with a space inside is text, so the next one counts',
    headers: { 'List-Unsubscribe': '<https://shop.example/u 1>, <https://shop.example/u/2>' },
    method: 'https',
    url: 'https://shop.example/u/2',
  },
  {
    name: 'an https target in upper case',
    headers: { 'List-Unsubscribe': '<HTTPS://shop.example/u/1>' },
    method: 'https',
    url: 'HTTPS://shop.example/u/1',
  },
  {
    name: 'no header',
    headers: {},
    method: 'none',
    url: null,
  },
];
