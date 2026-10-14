import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// each case runs in its own node process, because the functions end the process.
function run(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'okc-exit-'));
  const script = join(dir, 'case.ts');
  const url = (name: string) => pathToFileURL(join(import.meta.dirname, name)).href;
  writeFileSync(
    script,
    `import { exitOnFatal, exitOnUncaught, exitWhenIdle } from '${url('exit.ts')}';\n` +
      `import { createLogger } from '${url('observability/logger.ts')}';\n` +
      `import { registerSecret } from '${url('observability/redact.ts')}';\n` +
      `const logDir = ${JSON.stringify(join(dir, 'logs'))};\n${body}\n`,
  );
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 20_000 });
  const logs = (() => {
    try {
      return readdirSync(join(dir, 'logs')).map((name) => readFileSync(join(dir, 'logs', name), 'utf8')).join('');
    } catch {
      return '';
    }
  })();
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, logs };
}

describe('exitWhenIdle', () => {
  it('lets the pending work finish, and the process then ends with the code', () => {
    const result = run(`exitWhenIdle(3, 10_000); setTimeout(() => console.log('finished'), 50);`);
    expect(result).toMatchObject({ code: 3, stdout: 'finished\n' });
  });

  it('ends the process after the fallback time when a handle stays open', () => {
    const result = run(`setInterval(() => {}, 1_000); exitWhenIdle(0, 200);`);
    expect(result.code).toBe(0);
  });
});

describe('fatal errors', () => {
  it('writes an unhandled rejection to the log file with the secrets redacted, and exits with 1', () => {
    const result = run(
      `registerSecret('secret-value-123');\nconst logger = createLogger({ dir: logDir, consoleLevel: 'off' });\n` +
        `exitOnUncaught(() => logger);\nvoid Promise.reject(new Error('boom secret-value-123'));`,
    );
    expect(result.code).toBe(1);
    expect(result.logs).toContain('"msg":"fatal error"');
    expect(result.logs).toContain('boom [redacted]');
    expect(result.logs).not.toContain('secret-value-123');
  });

  it('writes the error to stderr with the secrets redacted before the logger exists', () => {
    const result = run(`registerSecret('secret-value-123');\nexitOnFatal('bad config near secret-value-123');`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('bad config near [redacted]');
    expect(result.stderr).not.toContain('secret-value-123');
  });
});
