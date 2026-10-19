import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// the bring-up fixes the node versions, and the docs name macos next to windows. these cases read the files, so a
// later change that drops a part of it fails here.

const repo = join(import.meta.dirname, '..');
const text = (file: string) => readFileSync(join(repo, file), 'utf8');

describe('the node versions of the bring-up', () => {
  it('names node 24 in .nvmrc and limits engines to 24 up to 26', () => {
    expect(text('.nvmrc').trim()).toBe('24');
    expect(JSON.parse(text('package.json')).engines.node).toBe('>=24 <27');
    // the root package of the lock file carries the same engines.
    expect(JSON.parse(text('package-lock.json')).packages[''].engines.node).toBe('>=24 <27');
  });

  it('runs on the node of this test', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(24);
    expect(major).toBeLessThan(27);
  });
});

describe('the docs for macos', () => {
  // each setup guide that tells the owner to store a secret with cmdkey also gives the security command of macos.
  it('gives a security command next to each cmdkey command in the setup guides', () => {
    for (const file of ['docs/setup/integrations.md', 'docs/setup/slack.md', 'docs/setup/google.md']) {
      const doc = text(file);
      if (doc.includes('cmdkey')) expect(doc, file).toMatch(/security (add|delete|find)-generic-password/);
    }
  });

  it('uses the service name of the keyring store in the security commands', () => {
    const service = /KEYRING_SERVICE = '([^']+)'/.exec(text('src/integrations/secrets.ts'))![1]!;
    for (const file of ['docs/setup/integrations.md', 'docs/setup/slack.md', 'docs/setup/google.md']) {
      for (const line of text(file).split('\n').filter((each) => /security \w+-generic-password/.test(each))) {
        expect(line, file).toContain(`-s ${service}`);
      }
    }
  });

  it('names the label, the plist and okc.sh in the readme and in the design', () => {
    const readme = text('README.md');
    expect(readme).toContain('scripts/okc.sh install');
    expect(readme).toContain('com.okcomputer.agent.plist');
    const design = text('docs/DESIGN.md');
    expect(design).toContain('scripts/okc.sh');
    expect(design).toContain('launchctl bootstrap gui/$UID');
    expect(design).toMatch(/macOS/);
    expect(text('docs/DESIGN-NEXT.md')).toMatch(/darwin/);
  });

  it('keeps the label of the template the same as the label of okc.sh', () => {
    const plist = text('scripts/macos/com.okcomputer.agent.plist');
    expect(plist).toContain('<string>com.okcomputer.agent</string>');
    expect(text('scripts/okc.sh')).toContain("label='com.okcomputer.agent'");
    for (const place of ['@@NODE@@', '@@ROOT@@', '@@PATH@@', '@@LOGS@@']) expect(plist).toContain(place);
  });
});
