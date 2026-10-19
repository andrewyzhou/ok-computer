import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CredentialStoreError } from '../integrations/secrets.js';
import { registerSecret } from '../observability/redact.js';
import { DEFAULT_AWS_PREFIX, PROBE_REF } from './config.js';
import type { CheckedSecretStore } from './index.js';

// the part of the sdk client that the store uses. tests give a fake that records the commands.
export type SecretsManagerPort = Pick<SecretsManagerClient, 'send'>;

export interface AwsSecretStoreOptions {
  region: string;
  // the start of each secret name. the default is okc/.
  prefix?: string;
  // tests give a fake client. the app makes a real client on the first use, so a desktop never loads the sdk.
  client?: SecretsManagerPort;
  // tests give a clock for the cache.
  now?: () => number;
}

// aws secrets manager keeps at most 65,536 bytes in one secret, and a name has at most 512 characters.
export const AWS_MAX_SECRET_BYTES = 65_536;
const MAX_NAME = 512;
const CACHE_MS = 60_000;

const KEPT = /[A-Za-z0-9/_+=.-]/;
// with the u flag, this class matches a surrogate only when it is not part of a pair.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

// the name of the secret that holds a ref. a ref can hold characters that a secret name cannot hold, for example
// the colon in "linear:oauth-tokens", so each such character is written as @ and two hex digits for each utf-8
// byte. the @ itself is written the same way, so each name comes from one ref only.
export function awsSecretName(prefix: string, ref: string): string {
  // a lone surrogate has no utf-8 form, and the encoder would write it as the same replacement character as any
  // other lone surrogate. two refs would then share a name.
  if (LONE_SURROGATE.test(ref)) throw new CredentialStoreError('a secret ref holds text that is not valid unicode');
  let name = '';
  for (const char of ref) {
    if (KEPT.test(char)) {
      name += char;
      continue;
    }
    for (const byte of Buffer.from(char, 'utf8')) name += `@${byte.toString(16).padStart(2, '0')}`;
  }
  if (prefix.length + name.length > MAX_NAME) {
    throw new CredentialStoreError(`a secret name is longer than ${MAX_NAME} characters, so give a shorter ref or prefix`);
  }
  return prefix + name;
}

type Sdk = typeof import('@aws-sdk/client-secrets-manager');

interface AwsError {
  name?: string;
  message?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

const errorOf = (err: unknown): AwsError => (typeof err === 'object' && err !== null ? (err as AwsError) : {});
const nameOf = (err: unknown) => errorOf(err).name ?? 'Error';
const isNotFound = (err: unknown) => nameOf(err) === 'ResourceNotFoundException';
const isExists = (err: unknown) => nameOf(err) === 'ResourceExistsException';
const isMarkedForDeletion = (err: unknown) =>
  nameOf(err) === 'InvalidRequestException' && /marked for deletion|scheduled for deletion/i.test(errorOf(err).message ?? '');
const isDenied = (err: unknown) =>
  ['AccessDeniedException', 'UnrecognizedClientException', 'CredentialsProviderError', 'ExpiredTokenException'].includes(
    nameOf(err),
  ) || errorOf(err).$metadata?.httpStatusCode === 403;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const isNetwork = (err: unknown) =>
  ['TimeoutError', 'NetworkingError', 'RequestTimeout', 'RequestTimeoutException'].includes(nameOf(err)) ||
  NETWORK_CODES.has(errorOf(err).code ?? '');

// the text names the kind of the error only. the message of an aws error can hold the secret name, which holds the ref.
const failed = (err: unknown) => new CredentialStoreError(`aws secrets manager failed: ${nameOf(err)}`);

// aws secrets manager with one secret for each ref, named prefix + ref.
export function createAwsSecretStore(options: AwsSecretStoreOptions): CheckedSecretStore {
  const { region, prefix = DEFAULT_AWS_PREFIX } = options;
  const now = options.now ?? Date.now;

  // the sdk loads on the first call. the client takes its credentials from the default chain, which is the instance
  // role on a server.
  let sdk: Promise<Sdk> | undefined;
  let client: Promise<SecretsManagerPort> | undefined;
  const loadSdk = () => (sdk ??= import('@aws-sdk/client-secrets-manager'));
  const loadClient = () =>
    (client ??= options.client ? Promise.resolve(options.client) : loadSdk().then((mod) => new mod.SecretsManagerClient({ region })));

  // the port types each command as the sdk does, so the call goes through one loose signature.
  const send = async (make: (mod: Sdk) => object): Promise<unknown> => {
    const [mod, port] = await Promise.all([loadSdk(), loadClient()]);
    return (port.send as (command: object) => Promise<unknown>)(make(mod));
  };

  // a value read in the last minute comes from memory, so a busy ref does not cost a request each time. a set or a
  // delete through this store drops the entry. a change from another host shows within the minute.
  const cache = new Map<string, { value: string | undefined; at: number }>();
  // a get that started before a set or a delete of the same ref must not cache the old value, so each write counts.
  const writes = new Map<string, number>();
  const wrote = (ref: string) => {
    writes.set(ref, (writes.get(ref) ?? 0) + 1);
    cache.delete(ref);
  };

  const read = async (name: string): Promise<string | undefined> => {
    try {
      const out = (await send((mod) => new mod.GetSecretValueCommand({ SecretId: name }))) as { SecretString?: string };
      return out.SecretString;
    } catch (err) {
      if (isNotFound(err) || isMarkedForDeletion(err)) return undefined;
      throw err;
    }
  };

  const put = (name: string, value: string) =>
    send((mod) => new mod.PutSecretValueCommand({ SecretId: name, SecretString: value }));
  const restore = (name: string) => send((mod) => new mod.RestoreSecretCommand({ SecretId: name }));

  const write = async (name: string, value: string) => {
    try {
      await put(name, value);
      return;
    } catch (err) {
      if (isMarkedForDeletion(err)) {
        await restore(name);
        await put(name, value);
        return;
      }
      if (!isNotFound(err)) throw err;
    }
    try {
      await send(
        (mod) => new mod.CreateSecretCommand({ Name: name, SecretString: value, Description: 'ok computer secret' }),
      );
    } catch (err) {
      // another process created the secret between the put and the create, so a second put works.
      if (isExists(err)) {
        await put(name, value);
        return;
      }
      if (isMarkedForDeletion(err)) {
        await restore(name);
        await put(name, value);
        return;
      }
      throw err;
    }
  };

  return {
    async get(ref) {
      const name = awsSecretName(prefix, ref);
      const hit = cache.get(ref);
      if (hit && now() - hit.at < CACHE_MS) {
        registerSecret(hit.value, ref);
        return hit.value;
      }
      const seen = writes.get(ref) ?? 0;
      let value: string | undefined;
      try {
        value = await read(name);
      } catch (err) {
        throw failed(err);
      }
      registerSecret(value, ref);
      if ((writes.get(ref) ?? 0) === seen) cache.set(ref, { value, at: now() });
      return value;
    },
    async set(ref, value) {
      registerSecret(value, ref);
      if (Buffer.byteLength(value, 'utf8') > AWS_MAX_SECRET_BYTES) {
        throw new CredentialStoreError(
          `the secret is longer than ${AWS_MAX_SECRET_BYTES.toLocaleString('en-US')} bytes, which aws secrets manager cannot keep`,
        );
      }
      const name = awsSecretName(prefix, ref);
      wrote(ref);
      try {
        await write(name, value);
      } catch (err) {
        throw failed(err);
      } finally {
        wrote(ref);
      }
    },
    async delete(ref) {
      const name = awsSecretName(prefix, ref);
      wrote(ref);
      try {
        await send((mod) => new mod.DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
      } catch (err) {
        if (!isNotFound(err) && !isMarkedForDeletion(err)) throw failed(err);
      } finally {
        wrote(ref);
      }
    },
    // the page shows these texts, so they name the region only and never a ref.
    async check() {
      try {
        await read(awsSecretName(prefix, PROBE_REF));
      } catch (err) {
        if (isDenied(err)) {
          throw new CredentialStoreError('aws secrets manager refused the access. Check the IAM role of the host.');
        }
        if (isNetwork(err)) throw new CredentialStoreError(`aws secrets manager did not answer in ${region}.`);
        throw failed(err);
      }
    },
  };
}
