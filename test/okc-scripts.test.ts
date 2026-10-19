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
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function startSupervisor(root: string, env = process.env): ChildProcess {
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'run.ps1')], { stdio: 'ignore', env });
  supervisors.push(child);
  return child;
}
const exited = (child: ChildProcess) => new Promise<number | null>((done) => (child.exitCode !== null ? done(child.exitCode) : child.once('exit', done)));
async function waitFor(condition: () => boolean, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (condition()) return;
  throw new Error('the condition did not become true');
}

// a fake agent that starts a child process, as the real agent starts mcp servers and chrome. a crash ends it soon; a
// second start only waits, so a supervisor that starts it again makes no new child.
function fakeAgentWithChild(crash: boolean): string {
  return [
    `const fs = require('node:fs');`,
    `if (fs.existsSync('data/child.pid')) setTimeout(() => {}, 3000);`,
    `else {`,
    `  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });`,
    `  fs.writeFileSync('data/child.pid', String(child.pid));`,
    crash ? `  setTimeout(() => process.exit(1), 300);` : `  setTimeout(() => {}, 15000);`,
    `}`,
  ].join('\n');
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
    expect(okc(root, `if (Get-AgentProcess) { 'agent' } else { 'none' }`)).toBe('none');
  });

  // the live folder points its data at the repository, and the agent writes the stop token there. okc stop read the
  // token from the data folder of its own root, did not find it, and always ended the agent by force.
  it('reads the stop token from the data folder of the config', () => {
    const root = makeRoot();
    expect(okc(root, 'Get-AgentDataPath')).toBe(join(root, 'data'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'okc-data-'));
    writeFileSync(join(root, 'okc.config.json'), JSON.stringify({ paths: { data: elsewhere.replaceAll('\\', '/') } }));
    expect(okc(root, 'Get-AgentDataPath')).toBe(elsewhere);
    writeFileSync(join(root, 'okc.config.json'), JSON.stringify({ paths: { data: 'state' } }));
    expect(okc(root, 'Get-AgentDataPath')).toBe(join(root, 'state'));
  });

  it('runs one supervisor for each root, also after a crash of the first one', async () => {
    const root = makeRoot();
    const pidFile = join(root, 'data', 'okc.pid');
    const nodePidFile = join(root, 'data', 'okc.node.pid');
    const first = startSupervisor(root);
    await waitFor(() => existsSync(nodePidFile));
    agents.push(Number(readFileSync(nodePidFile, 'utf8')));
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(first.pid));
    const found = okc(root, `$s = Get-Supervisor; $a = Get-AgentProcess; "$($s.Id) $($a.Id)"`);
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

  // a terminating error in the loop, here a missing node, ended the supervisor for good.
  it('keeps the supervisor running when a start of the agent fails', async () => {
    const root = makeRoot();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    const supervisor = startSupervisor(root, { ...env, Path: system32 });
    const log = join(root, 'data', 'logs', 'service.restarts.log');
    const logged = () => existsSync(log) && readFileSync(log, 'utf8').includes('supervisor error');
    await waitFor(() => supervisor.exitCode !== null || logged());
    expect(supervisor.exitCode).toBeNull();
    expect(logged()).toBe(true);
  });

  // okc stop said "not running" when the supervisor was gone, and left the agent with the data folder and the port.
  it('stops an agent without its supervisor, with its child processes, but not a process that reused its pid', async () => {
    const root = makeRoot();
    const nodePidFile = join(root, 'data', 'okc.node.pid');
    writeFileSync(join(root, 'dist', 'main.js'), fakeAgentWithChild(false));
    const agent = spawn(process.execPath, ['dist/main.js'], { cwd: root, stdio: 'ignore' });
    agents.push(agent.pid!);
    await waitFor(() => existsSync(join(root, 'data', 'child.pid')));
    const child = Number(readFileSync(join(root, 'data', 'child.pid'), 'utf8'));
    agents.push(child);

    // a pid file that is older than the process came from an earlier process with the same pid.
    const past = new Date(Date.now() - 60_000);
    writeFileSync(nodePidFile, String(agent.pid));
    utimesSync(nodePidFile, past, past);
    expect(okc(root, `if (Get-AgentProcess) { 'agent' } else { 'none' }`)).toBe('none');

    writeFileSync(nodePidFile, String(agent.pid));
    expect(okc(root, 'Stop-Agent')).toBe('ok computer stopped.');
    await waitFor(() => !alive(agent.pid!) && !alive(child));
  });

  it('starts a supervisor in place of an agent that lost its supervisor', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'dist', '.build-ok'), '');
    writeFileSync(join(root, 'dist', 'main.js'), fakeAgentWithChild(false));
    const agent = spawn(process.execPath, ['dist/main.js'], { cwd: root, stdio: 'ignore' });
    agents.push(agent.pid!);
    await waitFor(() => existsSync(join(root, 'data', 'child.pid')));
    agents.push(Number(readFileSync(join(root, 'data', 'child.pid'), 'utf8')));
    writeFileSync(join(root, 'data', 'okc.node.pid'), String(agent.pid));

    const pidFile = join(root, 'data', 'okc.pid');
    const nodePidFile = join(root, 'data', 'okc.node.pid');
    okc(root, '$NoOpen = $true; Start-Agent');
    await waitFor(() => existsSync(pidFile) && existsSync(nodePidFile));
    const supervisor = Number(readFileSync(pidFile, 'utf8'));
    agents.push(Number(readFileSync(nodePidFile, 'utf8')));
    process.kill(supervisor);
    await waitFor(() => !agents.slice(0, 2).some(alive));
  });

  // node on windows puts each child process that is not detached in a job that windows ends with node. so a crash or a
  // forced stop of the agent also ends its stdio mcp servers and its chrome, and the scripts need no tree kill.
  it('leaves no child process of an agent that crashed', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'dist', 'main.js'), fakeAgentWithChild(true));
    startSupervisor(root);
    await waitFor(() => existsSync(join(root, 'data', 'child.pid')));
    const child = Number(readFileSync(join(root, 'data', 'child.pid'), 'utf8'));
    agents.push(child);
    await waitFor(() => !alive(child));
  });

  // the shortcut and the logon task start okc in a hidden window, so a failed build showed nothing and left no trace.
  it('keeps the output of a hidden start in the launcher log', () => {
    const root = makeRoot();
    copyFileSync(join(scripts, 'okc.ps1'), join(root, 'scripts', 'okc.ps1'));
    const build = `node -e "console.error('type error in main.ts'); process.exit(2)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build } }));
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'okc.ps1'), 'start', '-NoOpen'];
    const result = spawnSync(powershell, args, { encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1);
    const log = readFileSync(join(root, 'data', 'logs', 'launcher.log'), 'utf8');
    expect(log).toContain('type error in main.ts');
    expect(log).toContain('error: the build failed.');
    expect(existsSync(join(root, 'data', 'okc.pid'))).toBe(false);
  });

  // a running agent keeps the code of its start. a build under it gave a dashboard page newer than its api.
  it('tells the owner to restart when the code on disk is newer than the running agent, and does not build under it', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'dist', 'main.js'), 'setTimeout(() => {}, 15000);\n');
    writeFileSync(join(root, 'dist', '.build-ok'), '');
    const nodePidFile = join(root, 'data', 'okc.node.pid');
    startSupervisor(root);
    await waitFor(() => existsSync(nodePidFile));
    agents.push(Number(readFileSync(nodePidFile, 'utf8')));
    const hint = 'run okc restart to load it.';
    expect(okc(root, '$NoOpen = $true; Start-Agent')).toBe('ok computer is already running.');

    writeFileSync(join(root, 'dist', '.build-ok'), '');
    expect(okc(root, '$NoOpen = $true; Start-Agent')).toContain(hint);

    // without a stamp the build is old. okc browser login then uses the files of the running agent.
    rmSync(join(root, 'dist', '.build-ok'));
    expect(okc(root, '$NoOpen = $true; Start-Agent')).toContain(hint);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: `node -e "require('fs').writeFileSync('built', '')"` } }));
    mkdirSync(join(root, 'dist', 'browser'));
    writeFileSync(join(root, 'dist', 'browser', 'login.js'), "console.log('login');\n");
    expect(okc(root, "$Sub = 'login'; Start-BrowserLogin")).toBe('login');
    expect(existsSync(join(root, 'built'))).toBe(false);
    process.kill(agents[0]!);
  });

  // the build empties dist, so a build under an agent that lost its supervisor deleted the files that agent runs.
  it('does not build for okc browser login under an agent without its supervisor', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'dist', 'main.js'), 'setTimeout(() => {}, 15000);\n');
    const agent = spawn(process.execPath, ['dist/main.js'], { cwd: root, stdio: 'ignore' });
    agents.push(agent.pid!);
    await waitFor(() => alive(agent.pid!));
    writeFileSync(join(root, 'data', 'okc.node.pid'), String(agent.pid));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: `node -e "require('fs').writeFileSync('built', '')"` } }));
    mkdirSync(join(root, 'dist', 'browser'));
    writeFileSync(join(root, 'dist', 'browser', 'login.js'), "console.log('login');\n");
    expect(okc(root, "$Sub = 'login'; Start-BrowserLogin")).toBe('login');
    expect(existsSync(join(root, 'built'))).toBe(false);
    process.kill(agent.pid!);
  });

  it('takes the node of OKC_NODE first, and fails clearly when it does not exist', () => {
    const root = makeRoot();
    expect(okc(root, `$env:OKC_NODE = '${process.execPath}'; Find-Node`).toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(okc(root, `$env:OKC_NODE = ''; Find-Node`).toLowerCase()).toMatch(/node(\.exe)?$/);
    const missing = join(root, 'no-node.exe');
    expect(okc(root, `$env:OKC_NODE = '${missing}'; try { Find-Node } catch { $_.Exception.Message }`)).toBe(
      `OKC_NODE is ${missing}, and that is not a program that can run.`,
    );
  });
});
