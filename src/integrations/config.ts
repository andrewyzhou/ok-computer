import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Result } from '../config/load.js';

// the id is the first part of each tool name, and a tool name has at most 64 characters.
const integrationId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,23}$/, 'use at most 24 lower-case letters, digits and dashes, for example "slack-work"');

const secretRef = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,99}$/, 'use lower-case letters, digits, dots, colons and dashes');

const risk = z.enum(['read', 'write', 'external']);

// sessions names the session profiles that see the tools: main, auto (automation runs), or sub:<profile>.
const profile = z.string().regex(/^(main|auto|sub:[a-z][a-z0-9-]*)$/, 'use "main", "auto", or "sub:<profile>"');

const common = {
  id: integrationId,
  tools: z.object({ allow: z.array(z.string().min(1)).min(1) }),
  risk: z.record(z.string(), risk).default({}),
  untrustedOutput: z.boolean().default(true),
  sessions: z.array(profile).min(1).default(['main']),
};

// an env value is plain text, or a reference to a secret in the credential manager.
const envValue = z.union([z.string(), z.object({ secretRef }).strict()]);

const stdioEntry = z
  .object({
    ...common,
    kind: z.literal('mcp-stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), envValue).default({}),
    cwd: z.string().optional(),
  })
  .strict();

const httpAuth = z.discriminatedUnion('type', [
  // without clientRef the client registers itself, when the server allows it.
  z.object({ type: z.literal('oauth'), clientRef: secretRef.optional(), scopes: z.array(z.string()).optional() }).strict(),
  z.object({ type: z.literal('bearer'), secretRef }).strict(),
]);

const httpEntry = z
  .object({
    ...common,
    kind: z.literal('mcp-http'),
    url: z.url({ protocol: /^https?$/ }),
    auth: httpAuth.optional(),
  })
  .strict();

const entry = z
  .discriminatedUnion('kind', [stdioEntry, httpEntry])
  // a server that changes under a moving tag can change its tools without a review.
  .refine((each) => each.kind !== 'mcp-stdio' || ![each.command, ...each.args].some((part) => /@latest\b/.test(part)), {
    message: 'pin an exact version instead of @latest',
  })
  .refine((each) => Object.keys(each.risk).every((tool) => each.tools.allow.includes(tool)), {
    message: 'every tool in risk must also be in tools.allow',
  });

const fileSchema = z
  .object({ integrations: z.array(entry).default([]) })
  .strict()
  .refine((file) => new Set(file.integrations.map((each) => each.id)).size === file.integrations.length, {
    message: 'each integration needs its own id',
  });

export type IntegrationEntry = z.infer<typeof entry>;
export type StdioEntry = z.infer<typeof stdioEntry>;
export type HttpEntry = z.infer<typeof httpEntry>;
export type Risk = z.infer<typeof risk>;

export function parseIntegrations(raw: unknown, source = 'integrations'): Result<IntegrationEntry[]> {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `${source} is invalid:\n${z.prettifyError(parsed.error)}` };
  return { ok: true, value: parsed.data.integrations };
}

// the file is optional. without it, the app has no integrations and offers no discovery tools.
export function loadIntegrations(path = 'okc.integrations.json'): Result<IntegrationEntry[]> {
  if (!existsSync(path)) return { ok: true, value: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, error: `${path} is not valid json: ${(err as Error).message}` };
  }
  return parseIntegrations(raw, path);
}

// a session key maps to the profile that the sessions field names.
export function sessionProfile(sessionKey: string): string {
  if (sessionKey === 'main') return 'main';
  if (sessionKey.startsWith('auto:')) return 'auto';
  if (sessionKey.startsWith('sub:')) return `sub:${sessionKey.split(':')[1]}`;
  return sessionKey.split(':')[0]!;
}
