import { describe, expect, it } from 'vitest';
import { CredentialStoreError } from '../integrations/secrets.js';
import { redact } from '../observability/redact.js';
import { awsSecretName, createAwsSecretStore, type SecretsManagerPort } from './aws.js';
import { createSecretVault } from './index.js';

// these tests try to break the aws backend: names that aws cannot hold, races between a get and a write, and error
// texts that could carry a ref.

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name, $metadata: {} });

// a promise that the test resolves by hand.
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

// a fake secrets manager whose commands can wait on a gate before they act.
function gatedClient() {
  const secrets = new Map<string, string>();
  const waits: Array<{ command: string; gate: Promise<void> }> = [];
  const sent: string[] = [];
  const send = async (command: { input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    sent.push(name);
    const wait = waits.findIndex((each) => each.command === name);
    if (wait >= 0) await waits.splice(wait, 1)[0]!.gate;
    const id = String(command.input.SecretId ?? command.input.Name);
    switch (name) {
      case 'GetSecretValueCommand':
        if (!secrets.has(id)) throw awsError('ResourceNotFoundException', `Secrets Manager can't find ${id}.`);
        return { SecretString: secrets.get(id) };
      case 'PutSecretValueCommand':
        if (!secrets.has(id)) throw awsError('ResourceNotFoundException', `Secrets Manager can't find ${id}.`);
        secrets.set(id, String(command.input.SecretString));
        return {};
      case 'CreateSecretCommand':
        if (secrets.has(id)) throw awsError('ResourceExistsException', `the secret ${id} already exists.`);
        secrets.set(id, String(command.input.SecretString));
        return {};
      case 'DeleteSecretCommand':
        if (!secrets.has(id)) throw awsError('ResourceNotFoundException', `Secrets Manager can't find ${id}.`);
        secrets.delete(id);
        return {};
      default:
        throw new Error(`the fake has no ${name}`);
    }
  };
  return { client: { send } as unknown as SecretsManagerPort, secrets, waits, sent };
}

// aws takes these characters in a secret name, and at most 512 of them.
const AWS_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

// the inverse of the name rule, so the test can show that no information is lost.
function decode(name: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '@') {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

describe('awsSecretName against hostile refs', () => {
  const refs = [
    'google.client',
    'google.personal',
    'linear:oauth-tokens',
    'slack:owner@example.com',
    '../../etc/passwd',
    'a b\tc\nd',
    '%40',
    '@40',
    '@@',
    '\u0000',
    'Ω≈ç√∫',
    '👩‍👩‍👧‍👦',
    'okc/env',
    '*',
    '?',
    'a'.repeat(300),
  ];

  it('gives a name that aws can hold, and the name gives the ref back', () => {
    for (const ref of refs) {
      const name = awsSecretName('okc/', ref);
      expect(name, ref).toMatch(AWS_NAME);
      expect(name.startsWith('okc/')).toBe(true);
      expect(decode(name.slice('okc/'.length)), ref).toBe(ref);
    }
  });

  it('takes an empty prefix, which the config allows', () => {
    expect(awsSecretName('', 'google:a')).toBe('google@3aa');
  });

  it('counts the length after the escape, so a ref of multi-byte characters fails before aws refuses it', () => {
    // each 🔑 is four utf-8 bytes, so each becomes 12 characters.
    expect(() => awsSecretName('okc/', '🔑'.repeat(43))).toThrow(CredentialStoreError);
    expect(awsSecretName('okc/', '🔑'.repeat(42))).toHaveLength(4 + 42 * 12);
  });
});

describe('the aws store under races', () => {
  it('does not cache the old value of a get that a set overtook', async () => {
    const fake = gatedClient();
    fake.secrets.set('okc/a', 'old-value-race-1111');
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    const slow = gate();
    fake.waits.push({ command: 'GetSecretValueCommand', gate: slow.opened });
    const reading = store.get('a');
    await store.set('a', 'new-value-race-2222');
    slow.open();
    // the slow get may give either value, but it must not stay in the cache.
    expect(['old-value-race-1111', 'new-value-race-2222']).toContain(await reading);
    expect(await store.get('a')).toBe('new-value-race-2222');
  });

  it('does not cache the old value of a get that a delete overtook', async () => {
    const fake = gatedClient();
    fake.secrets.set('okc/a', 'old-value-race-3333');
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    const slow = gate();
    fake.waits.push({ command: 'GetSecretValueCommand', gate: slow.opened });
    const reading = store.get('a');
    await store.delete('a');
    slow.open();
    await reading;
    expect(await store.get('a')).toBeUndefined();
  });

  it('reads again after a set that failed, so the cache never holds a value that aws does not have', async () => {
    const fake = gatedClient();
    fake.secrets.set('okc/a', 'kept-value-4444');
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    expect(await store.get('a')).toBe('kept-value-4444');
    // a put that throws an unknown error fails the set.
    const original = fake.client.send;
    (fake.client as { send: unknown }).send = async (command: object) => {
      if (command.constructor.name === 'PutSecretValueCommand') throw awsError('ThrottlingException', 'okc/a rate');
      return (original as (c: object) => Promise<unknown>)(command);
    };
    await expect(store.set('a', 'lost-value-5555')).rejects.toThrow(/^aws secrets manager failed: ThrottlingException$/);
    expect(await store.get('a')).toBe('kept-value-4444');
    expect(fake.sent.filter((each) => each === 'GetSecretValueCommand')).toHaveLength(2);
  });

  it('keeps every ref of many sets at the same time', async () => {
    const fake = gatedClient();
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.set(`ref:${i}`, `value-number-${i}-abcdef`)));
    for (let i = 0; i < 40; i++) expect(await store.get(`ref:${i}`)).toBe(`value-number-${i}-abcdef`);
  });
});

describe('the aws store keeps refs out of its errors', () => {
  it('a get, a set and a delete name only the kind of the error, never the secret name', async () => {
    const ref = 'google.secret-alias-zzz';
    const message = `User: arn:aws:sts::1:assumed-role/okc is not authorized on okc/${ref}`;
    const client = { send: async () => Promise.reject(awsError('AccessDeniedException', message)) } as unknown as SecretsManagerPort;
    const store = createAwsSecretStore({ region: 'us-east-1', client });
    for (const call of [() => store.get(ref), () => store.set(ref, 'value-of-the-ref-1234'), () => store.delete(ref)]) {
      const err = (await call().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect(err.message).toBe('aws secrets manager failed: AccessDeniedException');
      expect(err.message).not.toContain('secret-alias-zzz');
    }
  });

  it('a value that a get or a set touches goes to the redactor even when the call fails after', async () => {
    const client = { send: async () => Promise.reject(awsError('InternalServiceError')) } as unknown as SecretsManagerPort;
    const store = createAwsSecretStore({ region: 'us-east-1', client });
    await store.set('a', 'set-value-that-failed-6666').catch(() => {});
    expect(redact('x set-value-that-failed-6666 y')).toBe('x [redacted] y');
  });
});

describe('the aws vault', () => {
  it('uses okc/ when the config gives no prefix, and its view holds no ref', async () => {
    const sent: string[] = [];
    const client = {
      send: async (command: { input: { SecretId?: string } }) => {
        sent.push(String(command.input.SecretId));
        throw awsError('ResourceNotFoundException', `Secrets Manager can't find ${command.input.SecretId}.`);
      },
    } as unknown as SecretsManagerPort;
    const vault = createSecretVault({ backend: 'aws', region: 'ap-southeast-2' }, { awsClient: client });
    expect(await vault.view()).toEqual({ backend: 'aws', detail: 'ap-southeast-2, okc/', ok: true, error: null });
    expect(sent).toEqual(['okc/okc.probe']);
  });

  it('shows a probe that is scheduled for deletion as ok', async () => {
    const client = {
      send: async () => Promise.reject(awsError('InvalidRequestException', 'the secret okc/okc.probe is scheduled for deletion.')),
    } as unknown as SecretsManagerPort;
    const view = await createSecretVault({ backend: 'aws', region: 'us-east-1' }, { awsClient: client }).view();
    expect(view.ok).toBe(true);
  });

  it('shows an expired session as a refused access without the text of aws', async () => {
    const client = {
      send: async () => Promise.reject(awsError('ExpiredTokenException', 'The security token for okc/okc.probe expired')),
    } as unknown as SecretsManagerPort;
    const view = await createSecretVault({ backend: 'aws', region: 'us-east-1' }, { awsClient: client }).view();
    expect(view).toEqual({
      backend: 'aws',
      detail: 'us-east-1, okc/',
      ok: false,
      error: 'aws secrets manager refused the access. Check the IAM role of the host.',
    });
  });
});
