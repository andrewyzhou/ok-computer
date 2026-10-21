import { z } from 'zod';

// the plaid block of okc.config.json. every field has a default, so the bank works without the block once the client
// id and the secret are in .env (PLAID_CLIENT_ID, PLAID_SECRET) or in the keyring. see docs/setup/plaid.md.
//
// plaid has two hosts. a free trial plan (10 items, the plan of a new team) works on production with real banks, and
// counts each linked bank against its item limit. sandbox has only test banks, and its secret is another one. so the
// default is production.

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use the form HH:MM, from 00:00 to 23:59');

export const plaidConfigSchema = z.strictObject({
  environment: z.enum(['sandbox', 'production']).default('production'),
  // the most items that the plan allows. link refuses to start a new one at this count.
  itemLimit: z.number().int().min(1).max(10_000).default(10),
  // the days of history that link asks for. 730 is the most that plaid gives, and a yearly plan needs at least 400.
  daysRequested: z.number().int().min(30).max(730).default(730),
  // the countries of the banks that link shows, as two capital letters.
  countryCodes: z.array(z.string().regex(/^[A-Z]{2}$/, 'use two capital letters, for example US')).min(1).default(['US']),
  // the time of the daily sync, in the time zone of the app. it comes before the morning brief, so the brief has the
  // alerts of the night.
  syncAt: timeOfDay.default('06:30'),
  // the https page that a bank with an oauth sign-in returns to. it must be on the allowed list of the plaid dashboard.
  // without it, link opens the sign-in of such a bank in a popup, which works on a desktop browser.
  redirectUri: z.url({ protocol: /^https$/ }).optional(),
});

export type PlaidConfig = z.infer<typeof plaidConfigSchema>;

export const PLAID_HOSTS: Record<PlaidConfig['environment'], string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};
