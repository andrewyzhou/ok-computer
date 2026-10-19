import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';

// these tests read the deploy files as text and check what the other parts of the app expect of them: the path of
// the database, the dashboard port, the ci matrix, and which paths reach the build context.

const repo = join(import.meta.dirname, '..');
// a checkout on windows can turn lf into crlf, so the text is read with lf line ends. .gitattributes asks for lf.
const read = (path: string) => readFileSync(join(repo, path), 'utf8').replace(/\r\n/g, '\n');
const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

// the rules of a .dockerignore file: each pattern is a path from the root of the context, * and ? stay inside one
// path part, ** spans parts, a pattern that matches a folder leaves out all that is in it, and ! takes a path back.
// unlike .gitignore, a pattern without a slash does not match in a subfolder.
function dockerIgnored(patterns: string[], path: string): boolean {
  const toRegex = (pattern: string) => {
    let out = '';
    const clean = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
    for (let i = 0; i < clean.length; i++) {
      const char = clean[i]!;
      if (char === '*' && clean[i + 1] === '*') {
        out += '.*';
        i++;
        if (clean[i + 1] === '/') i++;
      } else if (char === '*') out += '[^/]*';
      else if (char === '?') out += '[^/]';
      else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}(/.*)?$`);
  };
  let ignored = false;
  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (toRegex(negated ? line.slice(1) : line).test(path)) ignored = !negated;
  }
  return ignored;
}

describe('the build context', () => {
  const patterns = read('.dockerignore').split('\n');

  it('takes the files that the build and the image need', () => {
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src/main.ts', 'src/db/migrations', 'web/index.html', 'workspace/AGENTS.md', 'deploy/entrypoint.sh']) {
      expect(dockerIgnored(patterns, path), path).toBe(false);
    }
  });

  it('leaves out run state and the root files of a run', () => {
    for (const path of ['.env', '.env.local', 'okc.config.json', 'okc.policy.json', 'okc.integrations.json', 'data/okc.sqlite', 'data/secrets.json', 'okc.sqlite-wal', 'node_modules/zod/package.json', 'web/node_modules/x', '.git/HEAD', 'workspace/USER.md']) {
      expect(dockerIgnored(patterns, path), path).toBe(true);
    }
  });

  it('leaves out deploy/.env, which the runbook fills with every secret of the server', () => {
    for (const path of ['deploy/.env', 'deploy/.env.local', 'web/.env']) expect(dockerIgnored(patterns, path), path).toBe(true);
  });

  // docs/setup/docker.md makes the run folder inside the project folder, so its secret file and config are near.
  it('leaves out a run folder and a data folder at any depth', () => {
    for (const path of ['run/.env', 'run/okc.config.json', 'run/data/secrets.json', 'run/data/blobs/a', 'deploy/data/okc.sqlite', 'x/data/secrets.json', 'x/okc.config.json']) {
      expect(dockerIgnored(patterns, path), path).toBe(true);
    }
  });
});

describe('the deploy files match the app', () => {
  const config = parseConfig({});
  if (!config.ok) throw new Error(config.error);

  it('litestream copies the file that the app opens in the run directory', () => {
    const litestream = withoutComments(read('deploy/litestream.yml'));
    // the image runs in /okc, and main.ts opens <paths.data>/okc.sqlite.
    expect(litestream).toContain(`path: /okc/${config.value.paths.data}/okc.sqlite`);
    const compose = withoutComments(read('deploy/compose.yaml'));
    expect(compose).toContain('/okc/data/okc.sqlite');
    expect(read('Dockerfile')).toContain('WORKDIR /okc');
  });

  it('tailscale serve sends the requests to the default dashboard port on loopback', () => {
    const serve = JSON.parse(read('deploy/tailscale-serve.json')) as { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
    const proxies = Object.values(serve.Web).flatMap((site) => Object.values(site.Handlers).map((handler) => handler.Proxy));
    expect(proxies).toEqual([`http://127.0.0.1:${config.value.dashboard.port}`]);
    expect(JSON.stringify(serve)).not.toMatch(/AllowFunnel/i);
  });

  it('the example config passes the schema and sets publicUrl, so the dashboard takes the tailnet name', () => {
    const example = JSON.parse(read('deploy/okc.config.example.json')) as unknown;
    const parsed = parseConfig(example);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.dashboard.publicUrl).toMatch(/^https:\/\/.+\.ts\.net$/);
    expect(parsed.value.secrets.backend).toBe('aws');
  });

  it('compose publishes no port and opens no host network for any service', () => {
    const compose = withoutComments(read('deploy/compose.yaml'));
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toMatch(/^\s*expose:/m);
    expect(compose).not.toMatch(/network_mode:\s*"?host"?/);
    expect(compose).not.toMatch(/privileged:\s*true/);
    expect(compose).not.toMatch(/funnel/i);
  });

  it('the app gets none of the variables of tailscale or of litestream', () => {
    const compose = withoutComments(read('deploy/compose.yaml'));
    const lines = compose.split('\n');
    const start = lines.indexOf('  app:');
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
    const app = rest.slice(0, end).join('\n');
    expect(app).not.toContain('TS_AUTHKEY');
    expect(app).not.toContain('env_file');
    expect(app).not.toContain('OKC_BACKUP_BUCKET');
  });
});

describe('.github/workflows/ci.yml', () => {
  const ci = withoutComments(read('.github/workflows/ci.yml'));

  it('tests on the three systems with node 24, on ubuntu also with node 26, and runs the gate in order', () => {
    expect(ci).toMatch(/os: \[ubuntu-latest, macos-latest, windows-latest\]\n\s*node: \[24\]/);
    expect(ci).toMatch(/include:\n\s*- os: ubuntu-latest\n\s*node: 26\n/);
    expect(ci).toContain('node-version: ${{ matrix.node }}');
    // the two ends of the matrix are the two ends of engines.
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=24 <27');
    const steps = ['npm ci', 'npm run typecheck', 'npm test', 'npm run build'].map((step) => ci.indexOf(`- run: ${step}`));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it('builds the image for both arches without a push or a secret', () => {
    expect(ci).toContain('platforms: linux/amd64,linux/arm64');
    expect(ci).toContain('push: false');
    expect(ci).not.toMatch(/secrets\./);
    expect(ci).toMatch(/permissions:\s*\n\s*contents: read/);
  });
});
