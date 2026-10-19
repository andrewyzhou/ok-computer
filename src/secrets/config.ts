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

const awsPrefix = z
  .string()
  .regex(
    /^[A-Za-z0-9/_+=.@-]{0,256}$/,
    'give a prefix of at most 256 characters that uses only letters, digits and the characters / _ + = . @ -',
  );

export const secretStoreConfigSchema = z.discriminatedUnion('backend', [
  z.strictObject({ backend: z.literal('keyring') }),
  z.strictObject({ backend: z.literal('file'), path: filePath }),
  z.strictObject({ backend: z.literal('aws'), region: awsRegion, prefix: awsPrefix.optional() }),
]);

export const DEFAULT_SECRET_STORE: SecretStoreConfig = { backend: 'keyring' };
export const DEFAULT_AWS_PREFIX = 'okc/';

// a check reads this ref, which nothing writes. it lives here and not in index.ts, so the backends can import it
// without an import cycle.
export const PROBE_REF = 'okc.probe';

// the schema and the shared type in types.ts must stay the same. a change to one of them without the other fails
// the typecheck here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<z.infer<typeof secretStoreConfigSchema>, SecretStoreConfig> = true;
void same;
