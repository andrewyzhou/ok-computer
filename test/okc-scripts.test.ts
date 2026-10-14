import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scripts = join(import.meta.dirname, '..', 'scripts');

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
});
