import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { SecretStoreConfig } from '../dashboard/types.js';

// the secrets block of okc.config.json chooses the place that keeps the secrets. a desktop uses the keyring, and a
// server uses a file with mode 0600 or aws secrets manager. see docs/PHASE5-API.md (m7).
const filePath = z
  .string()
  .min(1, 'give the path of the secret file, for example data/secrets.json')
  .refine((path) => !path.includes('\0'), 'give a path of the secret file without a nul character');

const awsRegion = z
  .string()
  .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'give an aws region in the form us-east-1');

// the runbook keeps the env of the host under this prefix, and the instance role may only read it, so no secret of
// the app goes there. it lives here and not in aws.ts, so the config does not load the aws code.
export const RESERVED_AWS_PREFIX = 'okc-host/';

const awsPrefix = z
  .string()
  .regex(
    /^[A-Za-z0-9/_+=.@-]{0,256}$/,
    'give a prefix of at most 256 characters that uses only letters, digits and the characters / _ + = . @ -',
  )
  .refine((prefix) => !prefix.startsWith(RESERVED_AWS_PREFIX), `give a prefix that does not start with ${RESERVED_AWS_PREFIX}, which holds the env of the host`);

export const secretStoreConfigSchema = z.discriminatedUnion('backend', [
  z.strictObject({ backend: z.literal('keyring') }),
  z.strictObject({ backend: z.literal('file'), path: filePath }),
  z.strictObject({ backend: z.literal('aws'), region: awsRegion, prefix: awsPrefix.optional() }),
]);

export const DEFAULT_SECRET_STORE: SecretStoreConfig = { backend: 'keyring' };
export const DEFAULT_AWS_PREFIX = 'okc/';

// the name of the folder that holds the secret file when the agent can read that folder, or undefined. both paths
// resolve from the working folder, as createFileSecretStore does.
export function secretFileExposedIn(path: string, folders: Record<string, string>): string | undefined {
  const file = resolve(process.cwd(), path);
  for (const [name, folder] of Object.entries(folders)) {
    const rel = relative(resolve(process.cwd(), folder), file);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return name;
  }
  return undefined;
}

// a check reads this ref, which nothing writes. it lives here and not in index.ts, so the backends can import it
// without an import cycle.
export const PROBE_REF = 'okc.probe';

// the schema and the shared type in types.ts must stay the same. a change to one of them without the other fails
// the typecheck here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<z.infer<typeof secretStoreConfigSchema>, SecretStoreConfig> = true;
void same;
