import { describe, expect, it } from 'vitest';
import { CredentialStoreError } from '../integrations/secrets.js';
import { redact } from '../observability/redact.js';
import { awsSecretName, createAwsSecretStore, type SecretsManagerPort } from './aws.js';

// an error with the name and the message that the sdk gives.
const awsError = (name: string, message = name, status?: number) =>
  Object.assign(new Error(message), { name, $metadata: status ? { httpStatusCode: status } : {} });

interface Sent {
  command: string;
  input: Record<string, unknown>;
}

// a fake secrets manager. it keeps the secrets in a map, records each command, and lets a test fail the next calls.
function fakeClient() {
  const secrets = new Map<string, string>();
  const deleted = new Set<string>();
  const sent: Sent[] = [];
  const failures: Array<{ command: string; error: Error }> = [];
  const send = async (command: { input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const input = command.input;
    sent.push({ command: name, input });
    const failure = failures.findIndex((f) => f.command === name);
    if (failure >= 0) throw failures.splice(failure, 1)[0]!.error;
    const id = String(input.SecretId ?? input.Name);
    const marked = () => awsError('InvalidRequestException', "You can't perform this operation on the secret because it was marked for deletion.");
    switch (name) {
      case 'GetSecretValueCommand':
        if (deleted.has(id)) throw marked();
        if (!secrets.has(id)) throw awsError('ResourceNotFoundException', `Secrets Manager can't find ${id}.`);
        return { SecretString: secrets.get(id) };
      case 'PutSecretValueCommand':
        if (deleted.has(id)) throw marked();
        if (!secrets.has(id)) throw awsError('ResourceNotFoundException');
        secrets.set(id, String(input.SecretString));
        return {};
      case 'CreateSecretCommand':
        if (secrets.has(id)) throw awsError('ResourceExistsException');
        secrets.set(id, String(input.SecretString));
        return {};
      case 'RestoreSecretCommand':
        deleted.delete(id);
        return {};
      case 'DeleteSecretCommand':
        if (!secrets.has(id)) throw awsError('ResourceNotFoundException');
        secrets.delete(id);
        return {};
      default:
        throw new Error(`the fake has no ${name}`);
    }
  };
  return { client: { send } as unknown as SecretsManagerPort, secrets, deleted, sent, failures };
}

const commands = (sent: Sent[]) => sent.map((s) => s.command);

describe('awsSecretName', () => {
  it('keeps the allowed characters and writes the others as @ and hex', () => {
    expect(awsSecretName('okc/', 'google/a_b+c=d.e-f')).toBe('okc/google/a_b+c=d.e-f');
    expect(awsSecretName('okc/', 'linear:oauth-tokens')).toBe('okc/linear@3aoauth-tokens');
    expect(awsSecretName('okc/', 'a@b#c d')).toBe('okc/a@40b@23c@20d');
    expect(awsSecretName('okc/', 'é')).toBe('okc/@c3@a9');
    expect(awsSecretName('okc/', '🔑')).toBe('okc/@f0@9f@94@91');
  });

  it('never gives one name for two refs', () => {
    const refs = new Set<string>();
    const alphabet = ['a', ':', '@', '3', 'A', '#', 'é', '🔑', '/', ' ', '%', '4', '0'];
    // every ref of up to three characters from the alphabet, which holds an escape and its own hex digits.
    const grow = (prefix: string, depth: number) => {
      refs.add(prefix);
      if (depth === 0) return;
      for (const char of alphabet) grow(prefix + char, depth - 1);
    };
    grow('', 3);
    refs.add('a@3a');
    refs.add('@3a');
    const names = new Map<string, string>();
    for (const ref of refs) {
      const name = awsSecretName('okc/', ref);
      expect(names.get(name), `${ref} and ${names.get(name)} share ${name}`).toBeUndefined();
      names.set(name, ref);
    }
    expect(names.size).toBe(refs.size);
  });

  it('refuses a name over 512 characters and a lone surrogate', () => {
    expect(awsSecretName('okc/', 'a'.repeat(508))).toHaveLength(512);
    expect(() => awsSecretName('okc/', 'a'.repeat(509))).toThrow(CredentialStoreError);
    expect(() => awsSecretName('okc/', ':'.repeat(170))).toThrow('longer than 512');
    expect(() => awsSecretName('okc/', 'a\uD800')).toThrow(CredentialStoreError);
  });
});

describe('the aws secret store', () => {
  it('gets a value and gives undefined for a missing one', async () => {
    const fake = fakeClient();
    fake.secrets.set('okc/google@3aowner', 'aws-value-redact-7171');
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    expect(await store.get('google:owner')).toBe('aws-value-redact-7171');
    expect(redact('aws-value-redact-7171')).toBe('[redacted]');
    expect(await store.get('missing')).toBeUndefined();
    expect(fake.sent[0]).toEqual({ command: 'GetSecretValueCommand', input: { SecretId: 'okc/google@3aowner' } });
  });

  it('caches a value for a minute, and its own set or delete drops the entry', async () => {
    let now = 1_000_000;
    const fake = fakeClient();
    fake.secrets.set('p/a', 'first-value-1234');
    const store = createAwsSecretStore({ region: 'us-east-1', prefix: 'p/', client: fake.client, now: () => now });
    expect(await store.get('a')).toBe('first-value-1234');
    fake.secrets.set('p/a', 'other-host-value-1234');
    now += 59_000;
    expect(await store.get('a')).toBe('first-value-1234');
    expect(commands(fake.sent).filter((c) => c === 'GetSecretValueCommand')).toHaveLength(1);
    now += 2_000;
    expect(await store.get('a')).toBe('other-host-value-1234');
    await store.set('a', 'own-value-1234');
    expect(await store.get('a')).toBe('own-value-1234');
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });

  it('sets a new secret with a put and then a create', async () => {
    const fake = fakeClient();
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    await store.set('a:b', 'new-value-redact-8282');
    expect(redact('new-value-redact-8282')).toBe('[redacted]');
    expect(fake.sent).toEqual([
      { command: 'PutSecretValueCommand', input: { SecretId: 'okc/a@3ab', SecretString: 'new-value-redact-8282' } },
      {
        command: 'CreateSecretCommand',
        input: { Name: 'okc/a@3ab', SecretString: 'new-value-redact-8282', Description: 'ok computer secret' },
      },
    ]);
    await store.set('a:b', 'second-value-1234');
    expect(commands(fake.sent).slice(2)).toEqual(['PutSecretValueCommand']);
    expect(fake.secrets.get('okc/a@3ab')).toBe('second-value-1234');
  });

  it('puts again when another process created the secret first', async () => {
    const fake = fakeClient();
    fake.failures.push({ command: 'PutSecretValueCommand', error: awsError('ResourceNotFoundException') });
    fake.secrets.set('okc/a', 'raced-value-1234');
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    await store.set('a', 'mine-value-1234');
    expect(commands(fake.sent)).toEqual(['PutSecretValueCommand', 'CreateSecretCommand', 'PutSecretValueCommand']);
    expect(fake.secrets.get('okc/a')).toBe('mine-value-1234');
  });

  it('restores a secret that is marked for deletion, and a get of it gives undefined', async () => {
    const fake = fakeClient();
    fake.secrets.set('okc/a', 'old-value-1234');
    fake.deleted.add('okc/a');
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    expect(await store.get('a')).toBeUndefined();
    await store.set('a', 'back-value-1234');
    expect(commands(fake.sent)).toEqual([
      'GetSecretValueCommand',
      'PutSecretValueCommand',
      'RestoreSecretCommand',
      'PutSecretValueCommand',
    ]);
    expect(await store.get('a')).toBe('back-value-1234');
  });

  it('refuses a value over 65,536 bytes without a request', async () => {
    const fake = fakeClient();
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    // each é is two bytes, so 32,769 of them are 65,538 bytes.
    const err = await store.set('a', 'é'.repeat(32_769)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialStoreError);
    expect((err as Error).message).toContain('65,536 bytes');
    expect((err as Error).message).not.toContain('é');
    expect(fake.sent).toEqual([]);
    await store.set('b', 'x'.repeat(65_536));
    expect(fake.secrets.get('okc/b')).toHaveLength(65_536);
  });

  it('deletes a secret at once, and a missing one is fine', async () => {
    const fake = fakeClient();
    fake.secrets.set('okc/a', 'value-of-a-1234');
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    await store.delete('a');
    await store.delete('a');
    expect(fake.sent[0]).toEqual({ command: 'DeleteSecretCommand', input: { SecretId: 'okc/a', ForceDeleteWithoutRecovery: true } });
    expect(fake.secrets.size).toBe(0);
  });

  it('names only the kind of an unknown error', async () => {
    const fake = fakeClient();
    fake.failures.push({ command: 'GetSecretValueCommand', error: awsError('InternalServiceError', 'okc/secret-ref broke') });
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    await expect(store.get('secret-ref')).rejects.toThrow(/^aws secrets manager failed: InternalServiceError$/);
  });

  it('check passes when the probe is not found', async () => {
    const fake = fakeClient();
    const store = createAwsSecretStore({ region: 'us-east-1', client: fake.client });
    await expect(store.check()).resolves.toBeUndefined();
    expect(fake.sent).toEqual([{ command: 'GetSecretValueCommand', input: { SecretId: 'okc/okc.probe' } }]);
  });

  it('check names the iam role on a refused access and the region on a network error', async () => {
    const fake = fakeClient();
    const store = createAwsSecretStore({ region: 'eu-west-2', client: fake.client });
    fake.failures.push({ command: 'GetSecretValueCommand', error: awsError('AccessDeniedException', 'not allowed on okc/okc.probe') });
    await expect(store.check()).rejects.toThrow('aws secrets manager refused the access. Check the IAM role of the host.');
    fake.failures.push({ command: 'GetSecretValueCommand', error: awsError('SomethingElse', 'x', 403) });
    await expect(store.check()).rejects.toThrow('refused the access');
    fake.failures.push({ command: 'GetSecretValueCommand', error: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    await expect(store.check()).rejects.toThrow('aws secrets manager did not answer in eu-west-2.');
    fake.failures.push({ command: 'GetSecretValueCommand', error: awsError('TimeoutError') });
    await expect(store.check()).rejects.toThrow('did not answer in eu-west-2.');
  });
});
