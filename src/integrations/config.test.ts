import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    expect(parsed.ok && parsed.value[0]).toMatchObject({ untrustedOutput: true, sessions: ['main'], auth: { callback: 'loopback' } });
  });

  it('polls slack dms only on an http entry that allows the two tools of the poll', () => {
    const polled = { ...slack, tools: { allow: ['slack_search_public_and_private', 'slack_read_user_profile'] }, risk: {}, poll: 'slack-dms' };
    expect(parseIntegrations({ integrations: [polled] })).toMatchObject({ ok: true });
    for (const allow of [['slack_search_public_and_private'], ['slack_read_user_profile']]) {
      expect(parseIntegrations({ integrations: [{ ...polled, tools: { allow } }] })).toMatchObject({ ok: false, error: expect.stringContaining('needs slack_search_public_and_private and slack_read_user_profile') });
    }
    expect(parseIntegrations({ integrations: [{ ...polled, poll: 'slack-channels' }] })).toMatchObject({ ok: false });
    const stdio = { id: 'slack-home', kind: 'mcp-stdio', command: 'npx', args: ['-y', 'slack-mcp-server@1.3.0'], tools: polled.tools, poll: 'slack-dms' };
    expect(parseIntegrations({ integrations: [stdio] })).toMatchObject({ ok: false });
  });

  it('loads both json examples of the slack guide', () => {
    // a checkout on windows can turn the guide into crlf text.
    const guide = readFileSync(join(import.meta.dirname, '../../docs/setup/slack.md'), 'utf8');
    const examples = [...guide.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
    expect(examples).toHaveLength(2);
    const [official, fallback] = examples.map((example) => parseIntegrations('integrations' in example ? example : { integrations: [example] }));
    expect(official).toMatchObject({ ok: true, value: [{ id: 'slack-work', poll: 'slack-dms', auth: { callback: 'paste' }, risk: { slack_send_message: 'external' } }] });
    expect(fallback).toMatchObject({ ok: true, value: [{ id: 'slack-work', kind: 'mcp-stdio' }] });
  });

  it('takes the paste callback for an oauth entry and refuses another word', () => {
    expect(parseIntegrations({ integrations: [{ ...slack, auth: { ...slack.auth, callback: 'paste' } }] })).toMatchObject({ ok: true });
    expect(parseIntegrations({ integrations: [{ ...slack, auth: { ...slack.auth, callback: 'https' } }] })).toMatchObject({ ok: false });
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

  it('reads the runner behind cmd /c, the short form npm x, an option before the runner word, and -p=', () => {
    const stdio = (command: string, args: string[]) => parseIntegrations({ integrations: [{ id: 'fs', kind: 'mcp-stdio', command, args, tools: { allow: ['read_file'] } }] });
    const refused: Array<[string, string[]]> = [
      ['cmd', ['/c', 'npx', '-y', 'some-notes-server']],
      ['cmd.exe', ['/d', '/C', 'npx', '-y', 'some-notes-server@next']],
      ['C:\\Windows\\System32\\cmd.exe', ['/c', 'npx -y some-notes-server']],
      ['npm', ['x', '-y', 'some-notes-server']],
      ['npm', ['--yes', 'exec', 'some-notes-server']],
      ['pnpm', ['--silent', 'dlx', 'some-notes-server']],
      ['npx', ['-p=some-notes-server@next', 'some-notes-server@1.0.0']],
    ];
    for (const [command, args] of refused) expect(stdio(command, args), `${command} ${args.join(' ')}`).toMatchObject({ ok: false, error: expect.stringContaining('no exact version') });
    expect(stdio('cmd', ['/c', 'npx', '-y', 'some-notes-server@1.4.2'])).toMatchObject({ ok: true });
    expect(stdio('cmd', ['/c', 'node', 'server.js'])).toMatchObject({ ok: true });
    expect(stdio('npm', ['--silent', 'run', 'server'])).toMatchObject({ ok: true });
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
