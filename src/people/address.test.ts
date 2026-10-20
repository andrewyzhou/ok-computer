import { describe, expect, it } from 'vitest';
import { guessedName, isPersonalDomain, organizationOf, parseAddressList } from './address.js';

describe('parseAddressList', () => {
  const cases: Array<[string, Array<[string, string | null]>]> = [
    ['Jane Doe <jane@acme.com>', [['jane@acme.com', 'Jane Doe']]],
    ['"Doe, Jane" <JANE@x.org>, bob@y.com', [['jane@x.org', 'Doe, Jane'], ['bob@y.com', null]]],
    ['bob@y.com', [['bob@y.com', null]]],
    ['<bob@y.com>', [['bob@y.com', null]]],
    ['bob@y.com (Bob Stone)', [['bob@y.com', 'Bob Stone']]],
    ['Bob <bob@y.com> (work)', [['bob@y.com', 'Bob']]],
    ['bob@y.com (a, b), carol@z.com', [['bob@y.com', 'a, b'], ['carol@z.com', null]]],
    ['team: a@b.co, d@e.fr;, last@x.org', [['a@b.co', null], ['d@e.fr', null], ['last@x.org', null]]],
    ['undisclosed-recipients:;', []],
    ['"Jane \\"JD\\" Doe" <jd@acme.com>', [['jd@acme.com', 'Jane "JD" Doe']]],
    ['"Jane, \\\\ x" <jd@acme.com>', [['jd@acme.com', 'Jane, \\ x']]],
    ['  Jane\r\n   Doe\r\n <jane@acme.com>,\r\n\tbob@y.com ', [['jane@acme.com', 'Jane Doe'], ['bob@y.com', null]]],
    ["'Jane Doe' <jane@acme.com>", [['jane@acme.com', 'Jane Doe']]],
    ['"\'Jane Doe\'" <jane@acme.com>', [['jane@acme.com', 'Jane Doe']]],
    ['"jane@acme.com" <Jane@Acme.com>', [['jane@acme.com', null]]],
    ['"" <jane@acme.com>', [['jane@acme.com', null]]],
    ['Jane <jane@acme.com>, JANE@acme.com (Other), Bob <bob@y.com>', [['jane@acme.com', 'Jane'], ['bob@y.com', 'Bob']]],
    ['not an address, Jane <jane@>, <@acme.com>, , ;, bob@y.com', [['bob@y.com', null]]],
    ['', []],
    ['"Doe; Jane" <jane@acme.com>; bob@y.com', [['jane@acme.com', 'Doe; Jane'], ['bob@y.com', null]]],
    ['Jane <jane+work@acme.com>', [['jane+work@acme.com', 'Jane']]],
  ];
  for (const [header, expected] of cases) {
    it(`reads ${JSON.stringify(header)}`, () => {
      expect(parseAddressList(header).map(({ email, name }) => ({ email, name }))).toEqual(expected.map(([email, name]) => ({ email, name })));
    });
  }

  it('gives the comment of a part that also has a name apart, and none when the comment is the name', () => {
    expect(parseAddressList('Bob <bob@y.com> (work)')).toEqual([{ email: 'bob@y.com', name: 'Bob', comment: 'work' }]);
    expect(parseAddressList('Jane (via Slack) <jane@x.com>')).toEqual([{ email: 'jane@x.com', name: 'Jane', comment: 'via Slack' }]);
    expect(parseAddressList('bob@y.com (Bob Stone)')).toEqual([{ email: 'bob@y.com', name: 'Bob Stone' }]);
  });
});

describe('guessedName', () => {
  const cases: Array<[string, string | null]> = [
    ['jane.doe@acme.com', 'Jane Doe'],
    ['JANE_DOE@acme.com', 'Jane Doe'],
    ['k.osei@acme.com', 'K Osei'],
    ['jdoe@acme.com', null],
    ['jane.doe2@acme.com', null],
    ['jane.doe+work@acme.com', null],
    ['.jane@acme.com', null],
  ];
  for (const [email, expected] of cases) it(`gives ${String(expected)} for ${email}`, () => expect(guessedName(email)).toBe(expected));
});

describe('isPersonalDomain', () => {
  const personal = ['gmail.com', 'GoogleMail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'gmx.de', 'gmx.net', 'yandex.ru', 'outlook.com', 'hotmail.co.uk', 'live.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'mail.com', 'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com', 'zoho.com', 'msn.com'];
  const work = ['acme.com', 'northgate.edu', 'mail.google.com', 'yahooinc.com', 'live.northgate.edu', 'outlook.acme.com', 'gmail.acme.com'];
  for (const domain of personal) it(`counts ${domain} as personal`, () => expect(isPersonalDomain(domain)).toBe(true));
  for (const domain of work) it(`does not count ${domain} as personal`, () => expect(isPersonalDomain(domain)).toBe(false));
});

describe('organizationOf', () => {
  const cases: Array<[string, { name: string; domain: string } | null]> = [
    ['acme.com', { name: 'Acme', domain: 'acme.com' }],
    ['mail.eu.acme.com', { name: 'Acme', domain: 'acme.com' }],
    ['cs.northgate.edu', { name: 'Northgate', domain: 'northgate.edu' }],
    ['foo.co.uk', { name: 'Foo', domain: 'foo.co.uk' }],
    ['mail.foo.co.uk', { name: 'Foo', domain: 'foo.co.uk' }],
    ['cs.ox.ac.uk', { name: 'Ox', domain: 'ox.ac.uk' }],
    ['ACME-Labs.com', { name: 'Acme Labs', domain: 'acme-labs.com' }],
    ['globex-labs.com', { name: 'Globex Labs', domain: 'globex-labs.com' }],
    ['a--b.com', { name: 'A B', domain: 'a--b.com' }],
    ['acme.co.jp', { name: 'Acme', domain: 'acme.co.jp' }],
    ['gmail.com', null],
    ['yahoo.co.uk', null],
    ['co.uk', null],
    ['com.au', null],
    ['localhost', null],
    ['', null],
  ];
  for (const [domain, expected] of cases) it(`gives ${JSON.stringify(expected)} for ${JSON.stringify(domain)}`, () => expect(organizationOf(domain)).toEqual(expected));
});
