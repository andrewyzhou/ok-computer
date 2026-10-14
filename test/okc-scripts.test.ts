import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..');
const scripts = join(repo, 'scripts');

// each case has its own root with a copy of run.ps1 and a fake agent that ends by itself after a few seconds. the
// functions of okc.ps1 load from the syntax tree of the script, so its commands do not run.
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'okc-scripts-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'data'));
  copyFileSync(join(scripts, 'run.ps1'), join(root, 'scripts', 'run.ps1'));
  writeFileSync(join(root, 'dist', 'main.js'), 'setTimeout(() => {}, 3000);\n');
  return root;
}

// the harness sets the variables that the top of okc.ps1 sets, for the root of the case.
function okc(root: string, body: string): string {
  const harness = join(root, 'harness.ps1');
  writeFileSync(
    harness,
    [
      `$root = '${root}'`,
      `$data = Join-Path $root 'data'`,
      `$pidFile = Join-Path $data 'okc.pid'`,
      `$nodePidFile = Join-Path $data 'okc.node.pid'`,
      `$supervisorScript = '${join(root, 'scripts', 'run.ps1')}'`,
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${join(scripts, 'okc.ps1')}', [ref]$null, [ref]$null)`,
      `foreach ($f in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) { . ([scriptblock]::Create($f.Extent.Text)) }`,
      body,
    ].join('\n'),
  );
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const supervisors: ChildProcess[] = [];
// the pids of the fake agents that the supervisors started.
const agents: number[] = [];
function startSupervisor(root: string): ChildProcess {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'run.ps1')], { stdio: 'ignore' });
  supervisors.push(child);
  return child;
}
const exited = (child: ChildProcess) => new Promise<number | null>((done) => (child.exitCode !== null ? done(child.exitCode) : child.once('exit', done)));
async function waitFor(condition: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (condition()) return;
  throw new Error('the condition did not become true');
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// only the powershell processes of the test stop here. each fake agent ends by itself, and the test waits for it, so
// no process holds the temporary folder when the teardown removes it.
afterEach(async () => {
  for (const child of supervisors.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited(child);
    }
  }
  await waitFor(() => agents.every((pid) => !alive(pid)));
  agents.length = 0;
});

describe.runIf(process.platform === 'win32')('the okc scripts', { timeout: 90_000 }, () => {
  // an empty file was read as pid 0, the idle process, so okc said "already running" for ever. a stale pid can belong
  // to any process, which okc stop then ended.
  it('trusts a pid file only when its process is the supervisor of this root', () => {
    const root = makeRoot();
    const pidFile = join(root, 'data', 'okc.pid');
    for (const text of ['', 'junk', String(process.pid)]) {
      writeFileSync(pidFile, text);
      expect(okc(root, `if (Get-Supervisor) { 'running' } else { 'none' }`)).toBe('none');
      expect(existsSync(pidFile)).toBe(false);
    }
    writeFileSync(join(root, 'data', 'okc.node.pid'), String(process.pid));
    expect(okc(root, `if (Get-AgentProcess ${process.pid}) { 'agent' } else { 'none' }`)).toBe('none');
  });

  it('runs one supervisor for each root, also after a crash of the first one', async () => {
    const root = makeRoot();
    const pidFile = join(root, 'data', 'okc.pid');
    const nodePidFile = join(root, 'data', 'okc.node.pid');
    const first = startSupervisor(root);
    await waitFor(() => existsSync(nodePidFile));
    agents.push(Number(readFileSync(nodePidFile, 'utf8')));
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(first.pid));
    const found = okc(root, `$s = Get-Supervisor; $a = Get-AgentProcess $s.Id; "$($s.Id) $($a.Id)"`);
    expect(found).toBe(`${first.pid} ${readFileSync(nodePidFile, 'utf8').trim()}`);

    // a second start at the same time ends at once and leaves the first one alone.
    expect(await exited(startSupervisor(root))).toBe(0);
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(first.pid));
    expect(first.exitCode).toBeNull();

    // a forced stop leaves the mutex abandoned. the next supervisor takes it.
    first.kill();
    await exited(first);
    const next = startSupervisor(root);
    await waitFor(() => readFileSync(pidFile, 'utf8').trim() === String(next.pid));
    await waitFor(() => existsSync(nodePidFile) && Number(readFileSync(nodePidFile, 'utf8')) !== agents[0]);
    agents.push(Number(readFileSync(nodePidFile, 'utf8')));
  });

  // tsc writes its output also when the types are wrong, so the next start saw a new dist/main.js and ran the broken
  // build. a deleted migration matters because the app applies each migration file that is in dist.
  it('builds again after a failed build and after a change of any build input', () => {
    const root = makeRoot();
    const past = new Date(Date.now() - 3_600_000);
    mkdirSync(join(root, 'src', 'db', 'migrations'), { recursive: true });
    const inputs = ['src/main.ts', 'src/db/migrations/001_a.sql', 'src/db/migrations/002_b.sql', 'package-lock.json'];
    for (const file of inputs) writeFileSync(join(root, file), 'x');
    for (const path of [...inputs, 'src/db/migrations', 'src/db', 'src']) utimesSync(join(root, path), past, past);
    const old = () => okc(root, 'Test-BuildIsOld');

    expect(old()).toBe('True');
    writeFileSync(join(root, 'dist', '.build-ok'), '');
    expect(old()).toBe('False');
    writeFileSync(join(root, 'package-lock.json'), 'y');
    expect(old()).toBe('True');
    utimesSync(join(root, 'package-lock.json'), past, past);
    expect(old()).toBe('False');
    rmSync(join(root, 'src/db/migrations/002_b.sql'));
    expect(old()).toBe('True');
  });

  it('writes no build output when the types are wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-tsc-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'main.ts'), 'export const n: number = "text";\n');
    const options = { rootDir: 'src', outDir: 'out', types: [] };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: join(repo, 'tsconfig.build.json'), compilerOptions: options, include: ['src'] }));
    const result = spawnSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', dir], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(dir, 'out', 'main.js'))).toBe(false);
  });
});
