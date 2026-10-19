import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';

const secretsOf = (secrets: unknown) => {
  const result = parseConfig({ secrets });
  if (!result.ok) throw new Error(result.error);
  return result.value.secrets;
};

const errorOf = (secrets: unknown) => {
  const result = parseConfig({ secrets });
  if (result.ok) throw new Error('the config was accepted');
  return result.error;
};

describe('the secrets block of the config', () => {
  it('uses the keyring when the block is missing', () => {
    const result = parseConfig({});
    if (!result.ok) throw new Error(result.error);
    expect(result.value.secrets).toEqual({ backend: 'keyring' });
  });

  it('takes a file block', () => {
    expect(secretsOf({ backend: 'file', path: 'data/secrets.json' })).toEqual({ backend: 'file', path: 'data/secrets.json' });
  });

  it('takes an aws block with and without a prefix', () => {
    expect(secretsOf({ backend: 'aws', region: 'us-east-1' })).toEqual({ backend: 'aws', region: 'us-east-1' });
    expect(secretsOf({ backend: 'aws', region: 'ap-southeast-2', prefix: 'prod/okc@1/' })).toEqual({
      backend: 'aws',
      region: 'ap-southeast-2',
      prefix: 'prod/okc@1/',
    });
    expect(secretsOf({ backend: 'aws', region: 'us-gov-west-1', prefix: '' })).toMatchObject({ prefix: '' });
  });

  it('refuses an unknown backend', () => {
    expect(errorOf({ backend: 'vault' })).toContain('secrets');
  });

  it('refuses an extra key', () => {
    expect(errorOf({ backend: 'keyring', path: 'x' })).toMatch(/unrecognized key/i);
    expect(errorOf({ backend: 'aws', region: 'us-east-1', profile: 'x' })).toMatch(/unrecognized key/i);
  });

  it('refuses a bad region', () => {
    for (const region of ['', 'US-EAST-1', 'us-east', 'useast1', 'us-east-1a']) {
      expect(errorOf({ backend: 'aws', region })).toContain('give an aws region in the form us-east-1');
    }
  });

  it('refuses a bad prefix', () => {
    expect(errorOf({ backend: 'aws', region: 'us-east-1', prefix: 'okc:' })).toContain('give a prefix');
    expect(errorOf({ backend: 'aws', region: 'us-east-1', prefix: 'a'.repeat(257) })).toContain('give a prefix');
  });

  it('refuses an empty path and a path with a nul character', () => {
    expect(errorOf({ backend: 'file', path: '' })).toContain('give the path of the secret file');
    expect(errorOf({ backend: 'file', path: 'data/\0x' })).toContain('without a nul character');
  });

  it('refuses a prefix in the reserved space of the host', () => {
    expect(errorOf({ backend: 'aws', region: 'us-east-1', prefix: 'okc-host/' })).toContain('okc-host/');
    expect(errorOf({ backend: 'aws', region: 'us-east-1', prefix: 'okc-host/app/' })).toContain('okc-host/');
    expect(secretsOf({ backend: 'aws', region: 'us-east-1', prefix: 'okc-hostx/' })).toMatchObject({ prefix: 'okc-hostx/' });
  });

  // the file tools of the agent read the workspace and the skills, so a secret file there is open to the model.
  it('refuses a secret file inside the workspace or the skills', () => {
    for (const path of ['workspace/secrets.json', './workspace/x/secrets.json', 'skills/secrets.json', 'data/../workspace/s.json']) {
      expect(errorOf({ backend: 'file', path }), path).toContain('outside paths.');
    }
    const moved = parseConfig({ paths: { workspace: 'ws' }, secrets: { backend: 'file', path: 'ws/s.json' } });
    expect(moved.ok).toBe(false);
    expect(secretsOf({ backend: 'file', path: 'workspace-secrets.json' })).toEqual({ backend: 'file', path: 'workspace-secrets.json' });
  });
});
