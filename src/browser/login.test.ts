import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserLogin } from './login.js';

describe('okc browser login', () => {
  it('opens a plain chrome on the hardened agent profile', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'okc-login-'));
    const launched: string[][] = [];
    const text = await browserLogin({ dataDir, url: 'https://accounts.example/', chrome: 'chrome.exe', launch: async (_chrome, args) => (launched.push(args), 0) });
    expect(text).toContain('sign-ins are saved');
    expect(launched).toEqual([[`--user-data-dir=${join(dataDir, 'browser', 'profile')}`, '--no-first-run', '--no-default-browser-check', 'https://accounts.example/']]);
    const prefs = JSON.parse(readFileSync(join(dataDir, 'browser', 'profile', 'Default', 'Preferences'), 'utf8'));
    expect(prefs).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { profile_enabled: false } });
  });

  it('keeps the other preferences of the profile', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'okc-login-'));
    mkdirSync(join(dataDir, 'browser', 'profile', 'Default'), { recursive: true });
    writeFileSync(join(dataDir, 'browser', 'profile', 'Default', 'Preferences'), JSON.stringify({ intl: { accept_languages: 'en-US' }, profile: { name: 'Agent' } }));
    await browserLogin({ dataDir, chrome: 'chrome.exe', launch: async () => 0 });
    const prefs = JSON.parse(readFileSync(join(dataDir, 'browser', 'profile', 'Default', 'Preferences'), 'utf8'));
    expect(prefs).toMatchObject({ intl: { accept_languages: 'en-US' }, profile: { name: 'Agent', password_manager_enabled: false } });
  });
});
