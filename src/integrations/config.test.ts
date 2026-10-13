import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redact } from '../observability/redact.js';
import { loadIntegrations, parseIntegrations, sessionProfile } from './config.js';
import { createMemorySecretStore } from './secrets.js';

const slack = {
  id: 'slack-work',
  kind: 'mcp-http',
  url: 'https://mcp.slack.com/mcp',
  auth: { type: 'oauth', clientRef: 'slack-work-app' },
  tools: { allow: ['search_messages', 'send_message'] },
  risk: { send_message: 'external' },
};

describe('integration registry', () => {
  it('fills the safe defaults', () => {
    const parsed = parseIntegrations({ integrations: [slack] });
    expect(parsed.ok && parsed.value[0]).toMatchObject({ untrustedOutput: true, sessions: ['main'] });
  });

  it('accepts a pinned stdio server with a secret in its env', () => {
    const parsed = parseIntegrations({
      integrations: [
        {
          id: 'github',
          kind: 'mcp-stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'],
          env: { GITHUB_TOKEN: { secretRef: 'github-token' } },
          tools: { allow: ['search_issues'] },
          sessions: ['main', 'auto'],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  it('refuses @latest, unknown risk tools, duplicate ids and bad names', () => {
    const latest = { id: 'x', kind: 'mcp-stdio', command: 'npx', args: ['pkg@latest'], tools: { allow: ['a'] } };
    expect(parseIntegrations({ integrations: [latest] })).toMatchObject({ ok: false, error: expect.stringContaining('@latest') });
    const risky = { ...slack, risk: { delete_everything: 'write' } };
    expect(parseIntegrations({ integrations: [risky] })).toMatchObject({ ok: false, error: expect.stringContaining('tools.allow') });
    expect(parseIntegrations({ integrations: [slack, slack] })).toMatchObject({ ok: false, error: expect.stringContaining('own id') });
    expect(parseIntegrations({ integrations: [{ ...slack, id: 'Slack Work' }] }).ok).toBe(false);
    expect(parseIntegrations({ integrations: [{ ...slack, url: 'file:///etc/passwd' }] }).ok).toBe(false);
  });

  it('refuses a package that a runner downloads without an exact version', () => {
    const stdio = (command: string, args: string[]) => parseIntegrations({ integrations: [{ id: 'fs', kind: 'mcp-stdio', command, args, tools: { allow: ['read_file'] } }] });
    for (const args of [['-y', '@scope/some-mcp-server'], ['-y', 'some-mcp-server@next'], ['some-mcp-server@^1.2.0'], ['some-mcp-server@*'], ['-y', '--package=tool@1.x', 'tool']]) {
      expect(stdio('npx', args)).toMatchObject({ ok: false, error: expect.stringContaining('no exact version') });
    }
    expect(stdio('C:\\Program Files\\nodejs\\npx.cmd', ['-y', 'some-mcp-server'])).toMatchObject({ ok: false });
    expect(stdio('pnpm', ['dlx', 'some-mcp-server@~1.2.0'])).toMatchObject({ ok: false });
    expect(stdio('bunx', ['some-mcp-server'])).toMatchObject({ ok: false });
    // an exact version, a prerelease, a local path and a command that is not a runner pass.
    expect(stdio('npx', ['-y', '@scope/some-mcp-server@1.2.3', '--root', 'C:\\notes'])).toMatchObject({ ok: true });
    expect(stdio('npx', ['-y', '--package', 'tool@2.0.0-beta.1', 'tool-bin', 'serve'])).toMatchObject({ ok: true });
    expect(stdio('npx', ['./servers/notes'])).toMatchObject({ ok: true });
    expect(stdio('pnpm', ['run', 'server'])).toMatchObject({ ok: true });
    expect(stdio('node', ['server.js'])).toMatchObject({ ok: true });
  });

  it('treats a missing file as no integrations and a broken file as an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-integrations-'));
    expect(loadIntegrations(join(dir, 'missing.json'))).toEqual({ ok: true, value: [] });
    writeFileSync(join(dir, 'broken.json'), '{');
    expect(loadIntegrations(join(dir, 'broken.json'))).toMatchObject({ ok: false, error: expect.stringContaining('not valid json') });
  });

  it('maps session keys to profiles', () => {
    expect(sessionProfile('main')).toBe('main');
    expect(sessionProfile('auto:abc:run-1')).toBe('auto');
    expect(sessionProfile('heartbeat:run-2')).toBe('heartbeat');
  });
});

describe('secret store', () => {
  it('keeps values out of logs once they pass through the store', async () => {
    const store = createMemorySecretStore();
    await store.set('slack-work:tokens', 'xoxp-secret-token-value');
    expect(await store.get('slack-work:tokens')).toBe('xoxp-secret-token-value');
    expect(redact('token xoxp-secret-token-value')).toBe('token [redacted]');
    await store.delete('slack-work:tokens');
    expect(await store.get('slack-work:tokens')).toBeUndefined();
  });
});
