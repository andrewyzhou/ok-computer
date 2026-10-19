import { z } from 'zod';
import type { SecretStoreConfig } from '../dashboard/types.js';

// the secrets block of okc.config.json chooses the place that keeps the secrets. a desktop uses the keyring, and a
// server uses a file with mode 0600 or aws secrets manager. see docs/PHASE5-API.md (m7).
// TODO(m7 secrets): add the checks of the work package. the path of a file is not empty, the region has the form
// us-east-1, and a prefix uses only the characters that a secret name can hold.
export const secretStoreConfigSchema = z.discriminatedUnion('backend', [
  z.strictObject({ backend: z.literal('keyring') }),
  z.strictObject({ backend: z.literal('file'), path: z.string().min(1) }),
  z.strictObject({ backend: z.literal('aws'), region: z.string().min(1), prefix: z.string().optional() }),
]);

export const DEFAULT_SECRET_STORE: SecretStoreConfig = { backend: 'keyring' };
export const DEFAULT_AWS_PREFIX = 'okc/';

// the schema and the shared type in types.ts must stay the same. a change to one of them without the other fails
// the typecheck here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<z.infer<typeof secretStoreConfigSchema>, SecretStoreConfig> = true;
void same;
