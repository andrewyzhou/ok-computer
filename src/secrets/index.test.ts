import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecretsManagerPort } from './aws.js';
import { createSecretVault, PROBE_REF } from './index.js';

const REF = 'google:owner@example.com';
const VALUE = 'vault-value-redact-9393';

// a fake client that holds one secret and can fail each get with one error.
function fakeClient(fail?: Error) {
  const send = async (command: { input: { SecretId?: string } }) => {
    if (fail) throw fail;
    if (command.constructor.name !== 'GetSecretValueCommand') return {};
    if (command.input.SecretId === 'okc/google@3aowner@40example.com') return { SecretString: VALUE };
    throw Object.assign(new Error(`Secrets Manager can't find ${command.input.SecretId}.`), { name: 'ResourceNotFoundException' });
  };
  return { send } as unknown as SecretsManagerPort;
}

const holdsNoSecret = (text: string | null) => {
  for (const part of [REF, VALUE, PROBE_REF, 'okc/okc.probe', 'google']) expect(text ?? '').not.toContain(part);
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createSecretVault', () => {
  it('opens the aws backend and shows it as ok', async () => {
    const vault = createSecretVault({ backend: 'aws', region: 'us-east-1' }, { awsClient: fakeClient() });
    expect(vault.backend).toBe('aws');
    expect(await vault.store.get(REF)).toBe(VALUE);
    const view = await vault.view();
    expect(view).toEqual({ backend: 'aws', detail: 'us-east-1, okc/', ok: true, error: null });
    holdsNoSecret(view.detail);
  });

  it('shows a refused aws access as one sentence without a ref', async () => {
    const denied = Object.assign(new Error(`User is not authorized to read okc/${PROBE_REF}`), { name: 'AccessDeniedException' });
    const vault = createSecretVault({ backend: 'aws', region: 'us-east-1', prefix: 'prod/' }, { awsClient: fakeClient(denied) });
    const view = await vault.view();
    expect(view.ok).toBe(false);
    expect(view.detail).toBe('us-east-1, prod/');
    expect(view.error).toBe('aws secrets manager refused the access. Check the IAM role of the host.');
    holdsNoSecret(view.error);
  });

  it('shows an unknown error with a fixed sentence', async () => {
    const odd = Object.assign(new Error(`odd thing with ${REF}`), { name: 'Odd' });
    const vault = createSecretVault({ backend: 'aws', region: 'us-east-1' }, { awsClient: fakeClient(odd) });
    const view = await vault.view();
    expect(view.ok).toBe(false);
    expect(view.error).toBe('aws secrets manager failed: Odd');
    holdsNoSecret(view.error);
  });

  it('opens the file backend with its path as the detail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-vault-'));
    dirs.push(dir);
    const path = join(dir, 'secrets.json');
    const vault = createSecretVault({ backend: 'file', path });
    expect(await vault.view()).toEqual({ backend: 'file', detail: path, ok: true, error: null });
    await vault.store.set(REF, VALUE);
    expect(await vault.store.get(REF)).toBe(VALUE);
    holdsNoSecret((await vault.view()).error);

    writeFileSync(path, `{"version":1,"secrets":{"${REF}":"${VALUE}"`);
    chmodSync(path, 0o600);
    const view = await vault.view();
    expect(view.ok).toBe(false);
    expect(view.error).toBe(`the secret file ${path} is damaged`);
    holdsNoSecret(view.error);
  });
});
