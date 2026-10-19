import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import { awsSecretName } from './aws.js';
import { secretFileExposedIn } from './config.js';

// these tests try the edges of the secrets block: each region form that aws uses, values of a wrong type, and the
// longest prefix that the schema takes.

const parse = (secrets: unknown) => parseConfig({ secrets });

const accepted = (secrets: unknown) => {
  const result = parse(secrets);
  if (!result.ok) throw new Error(result.error);
  return result.value.secrets;
};

const refused = (secrets: unknown) => {
  const result = parse(secrets);
  if (result.ok) throw new Error(`the config took ${JSON.stringify(secrets)}`);
  return result.error;
};

describe('the secrets block at its edges', () => {
  it('takes the region forms of every aws partition', () => {
    for (const region of ['us-east-1', 'eu-central-2', 'il-central-1', 'ap-southeast-4', 'mx-central-1', 'cn-northwest-1', 'us-gov-east-1', 'us-isob-east-1']) {
      expect(accepted({ backend: 'aws', region })).toEqual({ backend: 'aws', region });
    }
  });

  it('refuses a region with spaces, a zone or another shape', () => {
    for (const region of [' us-east-1', 'us-east-1 ', 'us_east_1', 'us-east-1-', '-us-east-1', 'u-east-1', 'us-east-01a', 'us-east-1\n']) {
      expect(refused({ backend: 'aws', region }), JSON.stringify(region)).toContain('give an aws region in the form us-east-1');
    }
  });

  it('refuses a block of a wrong type, a missing backend and a missing field', () => {
    for (const secrets of [null, 'keyring', ['keyring'], 7, {}, { backend: 'KEYRING' }, { backend: 'file' }, { backend: 'aws' }]) {
      expect(refused(secrets), JSON.stringify(secrets)).toContain('secrets');
    }
    expect(refused({ backend: 'file', path: 7 })).toContain('secrets');
    expect(refused({ backend: 'aws', region: 'us-east-1', prefix: 7 })).toContain('secrets');
  });

  it('takes a prefix of 256 characters, and a ref of the rest still fits a secret name', () => {
    const prefix = 'p'.repeat(255) + '/';
    expect(accepted({ backend: 'aws', region: 'us-east-1', prefix })).toEqual({ backend: 'aws', region: 'us-east-1', prefix });
    expect(awsSecretName(prefix, 'google.personal')).toHaveLength(256 + 'google.personal'.length);
  });

  it('refuses a prefix with a character that a secret name cannot hold', () => {
    for (const prefix of ['okc /', 'okc\\', 'okc*', 'okc#', 'ökc/', 'okc\n']) {
      expect(refused({ backend: 'aws', region: 'us-east-1', prefix }), JSON.stringify(prefix)).toContain('give a prefix');
    }
  });

  it('keeps the rest of the config when the block is the default', () => {
    const result = parseConfig({ dashboard: { port: 5000 } });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.secrets).toEqual({ backend: 'keyring' });
    expect(result.value.dashboard.port).toBe(5000);
  });
});

// the file tools of the agent can read the workspace through another letter case or through a link, so the check
// must not compare the paths only as text.
describe('a secret file next to the folders of the agent', () => {
  it('ignores letter case on macos and windows, and keeps it on linux', () => {
    // the folders do not exist, so no real path of this machine changes the case.
    const folders = { workspace: 'okc-no-workspace', skills: 'okc-no-skills' };
    expect(secretFileExposedIn('OKC-No-Workspace/secrets.json', folders, 'darwin')).toBe('workspace');
    expect(secretFileExposedIn('OKC-NO-SKILLS/secrets.json', folders, 'win32')).toBe('skills');
    expect(secretFileExposedIn('OKC-No-Workspace/secrets.json', folders, 'linux')).toBeUndefined();
    expect(secretFileExposedIn('data/secrets.json', folders, 'darwin')).toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')('follows a link into the workspace and a workspace that is a link', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'okc-secret-path-')));
    try {
      mkdirSync(join(root, 'workspace'));
      mkdirSync(join(root, 'data'));
      symlinkSync(join(root, 'workspace'), join(root, 'data', 'shared'));
      const folders = { workspace: join(root, 'workspace') };
      expect(secretFileExposedIn(join(root, 'data', 'shared', 'secrets.json'), folders, 'linux')).toBe('workspace');
      expect(secretFileExposedIn(join(root, 'data', 'secrets.json'), folders, 'linux')).toBeUndefined();

      // a link to a secret file in the data folder is still a file in the workspace.
      symlinkSync(join(root, 'data'), join(root, 'ws-link'));
      expect(secretFileExposedIn(join(root, 'data', 'secrets.json'), { workspace: join(root, 'ws-link') }, 'linux')).toBe('workspace');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
