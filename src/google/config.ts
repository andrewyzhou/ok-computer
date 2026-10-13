import { z } from 'zod';

// an alias is a part of each tool input and of each untrusted source, for example gmail:school.
const alias = z.string().regex(/^[a-z][a-z0-9-]{0,15}$/, 'use at most 16 lower-case letters, digits and dashes, for example "school"');

export const googleConfigSchema = z
  .object({
    // the client id of the "desktop app" oauth client. it is not a secret. the client secret is in the credential
    // manager.
    clientId: z.string().regex(/\.apps\.googleusercontent\.com$/, 'use the client id of the desktop app client, which ends in .apps.googleusercontent.com'),
    // the email is optional. when it is set, a sign-in with another google account is refused, so the alias can never
    // read the wrong mailbox.
    accounts: z.array(z.object({ alias, email: z.email().optional() }).strict()).min(1),
    // without send, the sign-in does not ask for gmail.send, and gmail_send is not a tool.
    send: z.boolean().default(false),
    sessions: z.array(z.enum(['main', 'auto'])).default(['main']),
    pollMinutes: z.number().int().min(5).max(24 * 60).default(15),
  })
  .strict()
  .refine((config) => new Set(config.accounts.map((each) => each.alias)).size === config.accounts.length, {
    message: 'each google account needs its own alias',
  });

export type GoogleConfig = z.infer<typeof googleConfigSchema>;

export const SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
  send: 'https://www.googleapis.com/auth/gmail.send',
  events: 'https://www.googleapis.com/auth/calendar.events',
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
} as const;

// the owner reads a missing scope in words on the sign-in page.
const SCOPE_WORDS: Record<string, string> = {
  [SCOPES.readonly]: 'read mail',
  [SCOPES.modify]: 'label and archive mail',
  [SCOPES.send]: 'send mail',
  [SCOPES.events]: 'change calendar events',
  [SCOPES.calendarRead]: 'read the calendar',
};

export const scopeWords = (scopes: string[]) => scopes.map((scope) => SCOPE_WORDS[scope] ?? scope).join(', ');

// a sign-in without these scopes is refused. google lets the owner untick each scope on the consent page, and a
// token without them fails at each poll.
export function requiredScopes(config: Pick<GoogleConfig, 'send'>): string[] {
  return [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead, ...(config.send ? [SCOPES.send] : [])];
}
