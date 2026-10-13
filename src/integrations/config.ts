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
  // without clientRef the client registers itself, when the server allows it. paste is for a server that accepts only
  // an https redirect, such as slack. the owner then pastes the address of the failed callback page on the dashboard.
  z
    .object({
      type: z.literal('oauth'),
      clientRef: secretRef.optional(),
      scopes: z.array(z.string()).optional(),
      callback: z.enum(['loopback', 'paste']).default('loopback'),
    })
    .strict(),
  z.object({ type: z.literal('bearer'), secretRef }).strict(),
]);

export const SLACK_POLL_TOOLS = ['slack_search_public_and_private', 'slack_read_user_profile'] as const;

const httpEntry = z
  .object({
    ...common,
    kind: z.literal('mcp-http'),
    url: z.url({ protocol: /^https?$/ }),
    auth: httpAuth.optional(),
    // slack-dms polls the direct messages of a workspace on the official slack server into integration_events.
    poll: z.literal('slack-dms').optional(),
  })
  .strict()
  // the poll calls the connection directly, and the connection does not check tools.allow. so the owner must allow
  // each tool that the poll calls.
  .refine((each) => each.poll !== 'slack-dms' || SLACK_POLL_TOOLS.every((tool) => each.tools.allow.includes(tool)), {
    message: `poll "slack-dms" needs ${SLACK_POLL_TOOLS.join(' and ')} in tools.allow`,
  });

const entry = z
  .discriminatedUnion('kind', [stdioEntry, httpEntry])
  // a server that changes under a moving tag can change its tools and its code without a review.
  .refine((each) => each.kind !== 'mcp-stdio' || ![each.command, ...each.args].some((part) => /@latest\b/.test(part)), {
    message: 'pin an exact version instead of @latest',
  })
  .superRefine((each, ctx) => {
    const spec = each.kind === 'mcp-stdio' ? unpinnedPackage(each.command, each.args) : undefined;
    if (spec !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `the package ${JSON.stringify(spec)} has no exact version. a tag, a range or no version lets the server change without a review. use, for example, some-server@1.4.2`,
      });
    }
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

// these runners download a package from the registry at each start, so the package must name an exact version. the
// value is the words after the command that select the runner, for example dlx in pnpm dlx, and x, the short form of
// npm exec. an empty list means that the command is the runner.
const RUNNERS: Record<string, string[]> = { npx: [], pnpx: [], bunx: [], pnpm: ['dlx'], yarn: ['dlx'], npm: ['exec', 'x'], bun: ['x'] };
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
// a path to a local package is the owner's own code, so it needs no version.
const LOCAL = /^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/]|file:)/i;

const baseName = (command: string) => command.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(cmd|exe|ps1)$/, '');

// unpinnedPackage gives the first package that a runner downloads without an exact version.
export function unpinnedPackage(command: string, args: string[]): string | undefined {
  // many server guides give cmd /c npx for windows. the command after /c or /k is the one that runs, and cmd can get
  // it as one text with spaces.
  if (baseName(command) === 'cmd') {
    const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
    if (at < 0 || at + 1 >= args.length) return undefined;
    const [inner, ...rest] = [...args[at + 1]!.trim().split(/\s+/), ...args.slice(at + 2)];
    return unpinnedPackage(inner!, rest);
  }
  const words = RUNNERS[baseName(command)];
  if (!words) return undefined;
  let i = 0;
  if (words.length) {
    // an option can come before the word, as in npm --yes exec.
    while (i < args.length && args[i]!.startsWith('-')) i++;
    if (!words.includes(args[i] ?? '')) return undefined;
    i++;
  }
  const packages: string[] = [];
  let explicit = false;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      if (!explicit && args[i + 1] !== undefined) packages.push(args[i + 1]!);
      break;
    }
    const named = /^(?:--package|-p)=(.+)$/.exec(arg)?.[1];
    if (named !== undefined) {
      packages.push(named);
      explicit = true;
    } else if (arg === '-p' || arg === '--package') {
      if (args[i + 1] !== undefined) packages.push(args[++i]!);
      explicit = true;
    } else if (!arg.startsWith('-')) {
      // the first argument that is not an option is the command. without --package, it is also the package.
      if (!explicit) packages.push(arg);
      break;
    }
  }
  return packages.find((spec) => !LOCAL.test(spec) && !EXACT.test(/^(@[^/@]+\/)?[^@]+@(.+)$/.exec(spec)?.[2] ?? ''));
}

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
