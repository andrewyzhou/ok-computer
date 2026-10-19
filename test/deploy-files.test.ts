import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';

const repo = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

// the checks read the files as text, so they need no yaml parser. comments are left out, because a comment may name
// a key that the file must not hold.
const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

// the block of one service is each line under its name at two spaces of indent, up to the next name at that indent.
function service(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`compose.yaml has no service ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

describe('deploy/compose.yaml', () => {
  const compose = withoutComments(read('deploy/compose.yaml'));

  it('publishes no port and has no version key', () => {
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toMatch(/^version:/m);
  });

  it('runs the app in the network of tailscale with an open stdin and an init process', () => {
    const app = service(compose, 'app');
    expect(app).toContain('network_mode: "service:tailscale"');
    expect(app).toContain('stdin_open: true');
    expect(app).toContain('init: true');
    expect(app).toMatch(/restore:\s*\n\s*condition: service_completed_successfully/);
  });

  it('restores the database only when it is missing', () => {
    const restore = service(compose, 'restore');
    expect(restore).toContain('-if-db-not-exists');
    expect(restore).toContain('-if-replica-exists');
    expect(restore).toContain('restart: "no"');
  });

  it('keeps TS_AUTHKEY out of the app', () => {
    const app = service(compose, 'app');
    expect(app).not.toContain('TS_AUTHKEY');
    expect(app).not.toContain('env_file');
    expect(service(compose, 'tailscale')).toContain('TS_AUTHKEY=');
  });

  it('pins each image to an exact tag', () => {
    expect(compose).toMatch(/image: tailscale\/tailscale:v\d+\.\d+\.\d+$/m);
    expect(compose).toMatch(/image: litestream\/litestream:\d+\.\d+\.\d+$/m);
  });
});

describe('deploy/tailscale-serve.json', () => {
  const serve = JSON.parse(read('deploy/tailscale-serve.json')) as {
    TCP: Record<string, { HTTPS?: boolean }>;
    Web: Record<string, { Handlers: Record<string, { Proxy?: string }> }>;
    AllowFunnel?: Record<string, boolean>;
  };

  it('serves https on 443 to the dashboard on loopback', () => {
    expect(serve.TCP['443']?.HTTPS).toBe(true);
    expect(serve.Web['${TS_CERT_DOMAIN}:443']?.Handlers['/']?.Proxy).toBe('http://127.0.0.1:4317');
  });

  it('never opens a funnel', () => {
    expect(Object.values(serve.AllowFunnel ?? {})).not.toContain(true);
  });
});

describe('deploy/okc.config.example.json', () => {
  it('passes the config schema with the aws store', () => {
    const parsed = parseConfig(JSON.parse(read('deploy/okc.config.example.json')), 'okc.config.example.json');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.secrets).toEqual({ backend: 'aws', region: 'us-east-1' });
    expect(parsed.value.dashboard.publicUrl).toMatch(/^https:\/\/okc\..+\.ts\.net$/);
  });
});

describe('Dockerfile', () => {
  const dockerfile = withoutComments(read('Dockerfile'));

  it('builds on an exact node 24 tag in each stage', () => {
    const bases = [...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map((match) => match[1]);
    expect(bases.length).toBeGreaterThanOrEqual(2);
    for (const base of bases) expect(base).toMatch(/^node:24\.\d+\.\d+-bookworm-slim$/);
  });

  it('runs as a user that is not root, with data as a volume', () => {
    const users = [...dockerfile.matchAll(/^USER (\S+)/gm)].map((match) => match[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).not.toMatch(/^(root|0)(:|$)/);
    expect(dockerfile).toMatch(/^VOLUME \["\/okc\/data"\]$/m);
    expect(dockerfile).toMatch(/^WORKDIR \/okc$/m);
  });

  it('gives channel chrome a browser on both arches', () => {
    expect(dockerfile).toContain('google-chrome-stable');
    expect(dockerfile).toContain('ln -s /usr/bin/chromium /opt/google/chrome/chrome');
  });
});

describe('.dockerignore', () => {
  it('keeps secrets and run state out of the build context', () => {
    const lines = read('.dockerignore').split('\n');
    for (const entry of ['node_modules', 'dist', 'data', '.env', '.env.*', 'okc.*.json', '.git', 'skills']) {
      expect(lines).toContain(entry);
    }
  });
});

describe('deploy/entrypoint.sh', () => {
  const script = read('deploy/entrypoint.sh');

  it('is a posix shell script that stops on errors and execs the command', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('set -eu');
    expect(script).toMatch(/exec "\$@"\s*$/);
    expect(script).toContain('okc.config.json');
  });

  // windows has no exec bit, and the Dockerfile sets it in the image.
  it.skipIf(process.platform === 'win32')('is executable', () => {
    expect(statSync(join(repo, 'deploy/entrypoint.sh')).mode & 0o111).not.toBe(0);
  });
});
