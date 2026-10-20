import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// these cases try the edges of okc.sh: odd paths, odd tokens, the plist values, and a pid of launchd that is wrong.
// each case has a fake home, a free port and stubs first on the path, so nothing reaches the launchd of the owner.

const repo = join(import.meta.dirname, '..');
const scripts = join(repo, 'scripts');
const label = 'com.okcomputer.agent';
const bash = '/bin/bash';
// windows has no /bin/sh, and the cases below skip there, so the lookup gives an empty path and does not throw at import.
const which = (name: string) =>
  process.platform === 'win32' ? '' : spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const realCurl = which('curl');

// the fake agent answers the overview and ends on a shutdown with its token. it ends by itself after a minute.
const fakeAgent = `
const fs = require('node:fs');
const path = require('node:path');
const data = path.join(__dirname, '..', 'data');
const token = require('node:crypto').randomBytes(16).toString('hex');
fs.writeFileSync(path.join(data, 'okc.stop-token'), token + '\\n');
fs.writeFileSync(path.join(data, 'agent.pid'), String(process.pid));
fs.writeFileSync(path.join(data, 'agent.service'), String(process.env.OKC_SERVICE));
setTimeout(() => process.exit(0), 60000);
require('node:http').createServer((req, res) => {
  if (req.url === '/api/overview') return res.writeHead(200).end('{}');
  if (req.method !== 'POST' || req.url !== '/api/shutdown') return res.writeHead(404).end();
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let ok = false;
    try { ok = JSON.parse(body).token === token; } catch {}
    res.writeHead(ok ? 200 : 401).end();
    if (ok) setImmediate(() => process.exit(0));
  });
}).listen(Number(new URL(process.env.OKC_URL).port), '127.0.0.1');
`;

const stubs: Record<string, string> = {
  launchctl: `echo "$*" >> "$STUB_DIR/launchctl.log"
case "$1" in
  print)
    # launchd removes a job a moment after bootout returns, so the job shows once more after a bootout.
    if [ -f "$STUB_DIR/unloading" ]; then rm -f "$STUB_DIR/unloading"; elif [ ! -f "$STUB_DIR/loaded" ]; then exit 113; fi
    echo "$2 = {"
    if [ -f "$STUB_DIR/launchd.pid" ]; then printf '\\tpid = %s\\n' "$(cat "$STUB_DIR/launchd.pid")"; fi
    echo "}" ;;
  bootstrap)
    if [ -f "$STUB_DIR/unloading" ]; then echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi
    touch "$STUB_DIR/loaded" ;;
  bootout) if [ -f "$STUB_DIR/loaded" ]; then rm -f "$STUB_DIR/loaded"; touch "$STUB_DIR/unloading"; fi ;;
esac`,
  open: `echo "$*" >> "$STUB_DIR/open.log"`,
  'xdg-open': `echo "$*" >> "$STUB_DIR/xdg-open.log"`,
  uname: `echo "$STUB_UNAME"`,
  npm: `echo "$*" >> "$STUB_DIR/npm.log"
mkdir -p dist && : > dist/.build-ok`,
  // the body of a request comes on stdin, and the stub keeps it.
  curl: `echo "$*" >> "$STUB_DIR/curl.log"
for arg in "$@"; do if [ "$arg" = '@-' ]; then cat > "$STUB_DIR/curl.body"; exec '${realCurl}' "$@" < "$STUB_DIR/curl.body"; fi; done
exec '${realCurl}' "$@"`,
};

type Case = { root: string; home: string; stub: string; env: NodeJS.ProcessEnv };
const cases: Case[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

async function makeCase(uname: 'Darwin' | 'Linux', name = 'okc-edge-'): Promise<Case> {
  // the script resolves its root with pwd -P, and tmpdir() on macos is under the /var link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  const home = mkdtempSync(join(tmpdir(), 'okc-home-'));
  const stub = mkdtempSync(join(tmpdir(), 'okc-stub-'));
  for (const dir of ['scripts', 'dist', 'data']) mkdirSync(join(root, dir));
  copyFileSync(join(scripts, 'okc.sh'), join(root, 'scripts', 'okc.sh'));
  cpSync(join(scripts, 'macos'), join(root, 'scripts', 'macos'), { recursive: true });
  writeFileSync(join(root, 'dist', 'main.js'), fakeAgent);
  writeFileSync(join(root, 'dist', '.build-ok'), '');
  mkdirSync(join(stub, 'bin'));
  for (const [file, body] of Object.entries(stubs)) {
    writeFileSync(join(stub, 'bin', file), `#!/bin/bash\n${body}\n`);
    chmodSync(join(stub, 'bin', file), 0o755);
  }
  const path = [join(stub, 'bin'), dirname(process.execPath), process.env.PATH].join(':');
  const env = { ...process.env, PATH: path, HOME: home, OKC_URL: `http://127.0.0.1:${await freePort()}`, STUB_DIR: stub, STUB_UNAME: uname };
  const made = { root, home, stub, env };
  cases.push(made);
  return made;
}

function run(c: Case, script: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; out: string }> {
  const child = spawn(bash, [script, ...args], { env: { ...c.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (out += chunk));
  return new Promise((done) => child.on('close', (status) => done({ status, out: out.trim() })));
}
const okc = (c: Case, args: string[], env: NodeJS.ProcessEnv = {}) => run(c, join(c.root, 'scripts', 'okc.sh'), args, env);

function sourced(c: Case, body: string): { status: number | null; out: string } {
  const result = spawnSync(bash, ['-c', 'source "$1"; eval "$2"', '_', join(c.root, 'scripts', 'okc.sh'), body], { env: c.env, encoding: 'utf8' });
  return { status: result.status, out: (result.stdout + result.stderr).trim() };
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(condition: () => boolean | Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (await condition()) return;
  throw new Error('the condition did not become true');
}
const answers = (c: Case) => async () => {
  try {
    await fetch(`${c.env.OKC_URL}/api/overview`);
    return true;
  } catch {
    return false;
  }
};
const agentPid = (c: Case) => Number(read(join(c.root, 'data', 'agent.pid')));

const extra: string[] = [];

afterEach(() => {
  for (const c of cases.splice(0)) {
    const pid = agentPid(c);
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    for (const dir of [c.root, c.home, c.stub]) rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('okc.sh at its edges', { timeout: 60_000 }, () => {
  // the bash 3.2 of macos treated an empty "$@" or an empty array as unbound under set -u in some versions.
  it('starts with no arguments at all on the bash of the system, and opens the dashboard', async () => {
    const c = await makeCase('Darwin');
    const started = await okc(c, []);
    expect(started).toEqual({ status: 0, out: 'ok computer started.' });
    await waitFor(answers(c));
    expect(read(join(c.stub, 'open.log'))).toBe(`${c.env.OKC_URL}\n`);
    expect(existsSync(join(c.stub, 'npm.log'))).toBe(false);
    expect((await okc(c, ['stop'])).out).toBe('ok computer stopped.');
  });

  it('counts a stamp with no input files as fresh, and the empty list does not trip set -u', async () => {
    const c = await makeCase('Linux');
    expect(sourced(c, 'set -u; if build_is_old; then echo old; else echo fresh; fi')).toEqual({ status: 0, out: 'fresh' });
    rmSync(join(c.root, 'dist', '.build-ok'));
    expect(sourced(c, 'set -u; if build_is_old; then echo old; else echo fresh; fi')).toEqual({ status: 0, out: 'old' });
  });

  it('prints the usage for an unknown command and for browser without login, as okc.ps1 does', async () => {
    const c = await makeCase('Linux');
    expect(await okc(c, ['frobnicate'])).toEqual({
      status: 0,
      out: 'usage: okc [start|stop|restart|status|open|logs|browser login [url]|install|uninstall] [--no-open]',
    });
    expect(await okc(c, ['browser', 'logout'])).toEqual({ status: 0, out: 'usage: okc browser login [url]' });
  });

  // a token is hex today, but the json body must stay valid for any text in the file.
  it('sends a stop token with quotes and backslashes as valid json on stdin', async () => {
    const c = await makeCase('Linux');
    const token = 'a"b\\c\\"d';
    writeFileSync(join(c.root, 'data', 'okc.stop-token'), `  ${token}\r\n`);
    // the agent of the case is this test process, so agent_pid and pid_matches are replaced after the source.
    const result = sourced(c, `agent_pid() { agent=${process.pid}; agent_source=file; }; pid_matches() { return 1; }; stop_agent`);
    expect(result).toEqual({ status: 0, out: 'ok computer stopped.' });
    expect(JSON.parse(read(join(c.stub, 'curl.body')))).toEqual({ token });
    expect(read(join(c.stub, 'curl.log'))).toContain(`${c.env.OKC_URL}/api/shutdown`);
    expect(read(join(c.stub, 'curl.log'))).not.toContain('a"b');
  });

  it('restarts the agent, keeps --no-open, and the new agent has a new pid', async () => {
    const c = await makeCase('Linux');
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    const first = agentPid(c);
    const restarted = await okc(c, ['restart', '--no-open']);
    expect(restarted).toEqual({ status: 0, out: 'ok computer stopped.\nok computer started.' });
    expect(alive(first)).toBe(false);
    await waitFor(() => agentPid(c) !== first && alive(agentPid(c)));
    await waitFor(answers(c));
    expect(read(join(c.root, 'data', 'okc.node.pid')).trim()).toBe(String(agentPid(c)));
    expect(existsSync(join(c.stub, 'xdg-open.log'))).toBe(false);
  });

  // launchd keeps the job loaded after a clean stop. its pid can be a stale one that the system gave to another
  // process, and then the pid file of a plain start still counts.
  it('falls back to the pid file when launchd reports a pid of another process', async () => {
    const c = await makeCase('Darwin');
    mkdirSync(join(c.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(c.home, 'Library', 'LaunchAgents', `${label}.plist`), '');
    writeFileSync(join(c.stub, 'loaded'), '');
    writeFileSync(join(c.stub, 'launchd.pid'), String(process.pid));
    expect((await okc(c, ['status'])).out.split('\n')[0]).toBe('not running');
    // a plain start next to a loaded job kicks the job and runs no agent of its own.
    expect((await okc(c, ['start', '--no-open'])).out).toBe('ok computer started.');
    expect(read(join(c.stub, 'launchctl.log'))).toContain(`kickstart gui/${process.getuid!()}/${label}`);
    expect(existsSync(join(c.root, 'data', 'okc.node.pid'))).toBe(false);
    expect(alive(process.pid)).toBe(true);
  });

  // the plist is xml, and sed fills the template, so a root with | or \ or & must not break either.
  it('fills the plist for a root with sed and xml special characters, and the values parse back exactly', async () => {
    const c = await makeCase('Darwin', 'okc|sh\\x&y-');
    const result = await okc(c, ['install']);
    expect(result).toEqual({ status: 0, out: `installed: okc command and the ${label} login agent.` });
    const plist = join(c.home, 'Library', 'LaunchAgents', `${label}.plist`);
    expect(existsSync(plist)).toBe(true);
    if (!existsSync('/usr/bin/plutil')) return;
    const parsed = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout);
    const node = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: c.env, encoding: 'utf8' }).stdout.trim();
    expect(parsed.Label).toBe(label);
    expect(parsed.ProgramArguments).toEqual([node, `${c.root}/dist/main.js`]);
    expect(parsed.ProgramArguments[0].startsWith('/')).toBe(true);
    expect(parsed.WorkingDirectory).toBe(c.root);
    expect(parsed.RunAtLoad).toBe(true);
    expect(parsed.KeepAlive).toEqual({ SuccessfulExit: false });
    // launchd gives /dev/null as stdin, and the variable keeps the agent from a cli that would end at once.
    expect(parsed.EnvironmentVariables.OKC_SERVICE).toBe('1');
    expect(parsed.ExitTimeOut).toBe(60);
    expect(parsed.ThrottleInterval).toBe(60);
    const path: string[] = parsed.EnvironmentVariables.PATH.split(':');
    expect(path[0]).toBe(dirname(node));
    expect(path).toContain('/opt/homebrew/bin');
    expect(path).toContain('/usr/bin');
    expect(parsed.StandardOutPath).toBe(join(c.root, 'data', 'logs', 'launchd.out.log'));
    expect(parsed.StandardErrorPath).toBe(join(c.root, 'data', 'logs', 'launchd.err.log'));
  });

  // a second agent cannot hold the data folder next to the one that launchd starts.
  it('stops an agent of a plain start before it loads the login agent, and loads a loaded job again', async () => {
    const c = await makeCase('Darwin');
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    const pid = agentPid(c);
    const result = await okc(c, ['install']);
    expect(result).toEqual({ status: 0, out: `ok computer stopped.\ninstalled: okc command and the ${label} login agent.` });
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(c.root, 'data', 'okc.node.pid'))).toBe(false);
    const uid = process.getuid!();
    // a second install boots the old job out before the bootstrap, because a bootstrap of a loaded job fails.
    await okc(c, ['install']);
    const log = read(join(c.stub, 'launchctl.log'));
    const bootout = log.indexOf(`bootout gui/${uid}/${label}`);
    expect(bootout).toBeGreaterThan(-1);
    expect(log.indexOf(`bootstrap gui/${uid}`, bootout)).toBeGreaterThan(bootout);
  });

  // a pid file of a plain start next to a login agent on linux: linux never asks launchctl.
  it('never runs launchctl on linux, also when a plist exists in the fake home', async () => {
    const c = await makeCase('Linux');
    mkdirSync(join(c.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(c.home, 'Library', 'LaunchAgents', `${label}.plist`), '');
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    expect((await okc(c, ['status'])).out.split('\n')[0]).toBe(`running (pid ${agentPid(c)})`);
    expect((await okc(c, ['stop'])).out).toBe('ok computer stopped.');
    expect(existsSync(join(c.stub, 'launchctl.log'))).toBe(false);
  });

  // a large launcher log starts again, so it cannot fill the disk over months of starts.
  it('starts the launcher log again when it is over 1 mb', async () => {
    const c = await makeCase('Linux');
    mkdirSync(join(c.root, 'data', 'logs'));
    writeFileSync(join(c.root, 'data', 'logs', 'launcher.log'), 'x'.repeat(1_048_577));
    await okc(c, ['stop']);
    expect(read(join(c.root, 'data', 'logs', 'launcher.log'))).toBe('ok computer is not running.\n');
  });

  it('starts the agent as a service, so its stdin of /dev/null does not stop it', async () => {
    const c = await makeCase('Linux');
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    expect(read(join(c.root, 'data', 'agent.service'))).toBe('1');
    await okc(c, ['stop']);
  });

  it('keeps the pid of the agent that runs when two starts race', async () => {
    for (let round = 0; round < 4; round++) {
      const c = await makeCase('Linux');
      await Promise.all([okc(c, ['start', '--no-open']), okc(c, ['start', '--no-open'])]);
      await waitFor(answers(c));
      await new Promise((r) => setTimeout(r, 1500));
      const port = new URL(c.env.OKC_URL!).port;
      const listener = Number(spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim());
      const status = (await okc(c, ['status'])).out.split('\n')[0];
      process.kill(listener, 'SIGKILL');
      expect(status).toBe(`running (pid ${listener})`);
    }
  }, 120_000);

  it('takes over a start lock whose shell ended', async () => {
    const c = await makeCase('Linux');
    mkdirSync(join(c.root, 'data', 'okc.start.lock'));
    const ended = spawnSync(process.execPath, ['-e', '']).pid!;
    writeFileSync(join(c.root, 'data', 'okc.start.lock', 'pid'), String(ended));
    expect((await okc(c, ['start', '--no-open'])).out).toBe('ok computer started.');
    expect(existsSync(join(c.root, 'data', 'okc.start.lock'))).toBe(false);
    await waitFor(answers(c));
    await okc(c, ['stop']);
  });

  // a forced stop skips the end of the agent, and the chrome of its profile would keep the profile lock.
  it('ends a process of the agent profile after a forced stop, and leaves other processes alone', async () => {
    const c = await makeCase('Linux');
    const profile = join(c.root, 'data', 'browser', 'profile');
    const chrome = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`], { stdio: 'ignore' });
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}-other`], { stdio: 'ignore' });
    await waitFor(() => spawnSync('ps', ['-p', String(other.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.includes('-other'));
    try {
      // the agent of the case is this test process. it counts as alive for the first check only, and its kill does
      // nothing, so the forced stop runs and ends no test process.
      const body = `agent_pid() { agent=${process.pid}; agent_source=file; }; calls=0; pid_matches() { ((++calls == 1)); }; kill() { if [[ "$2" == ${process.pid} ]]; then return 0; fi; command kill "$@"; }; stop_agent`;
      const result = sourced(c, body);
      expect(result.out).toContain('ok computer stopped.');
      await waitFor(() => !alive(chrome.pid!), 5_000);
      expect(alive(other.pid!)).toBe(true);
    } finally {
      chrome.kill('SIGKILL');
      other.kill('SIGKILL');
    }
  });

  it('shows the starts and the last exit code that launchd keeps', async () => {
    const c = await makeCase('Darwin');
    mkdirSync(join(c.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(c.home, 'Library', 'LaunchAgents', `${label}.plist`), '');
    writeFileSync(join(c.stub, 'loaded'), '');
    const stub = join(c.stub, 'bin', 'launchctl');
    writeFileSync(stub, `#!/bin/bash\nprintf '%s = {\\n\\truns = 7\\n\\tlast exit code = 1\\n}\\n' "$2"\n`);
    const out = (await okc(c, ['status'])).out.split('\n');
    expect(out.slice(0, 3)).toEqual(['not running', 'launchd runs: 7', 'launchd last exit code: 1']);
  });

  it('cuts the launchd logs in place to their last lines when they are over 1 mb', async () => {
    const c = await makeCase('Linux');
    mkdirSync(join(c.root, 'data', 'logs'));
    const err = join(c.root, 'data', 'logs', 'launchd.err.log');
    writeFileSync(err, `${'x'.repeat(600)}\n`.repeat(2000) + 'last line\n');
    await okc(c, ['stop']);
    const kept = read(err).split('\n');
    expect(kept.length).toBe(1001);
    expect(kept.at(-2)).toBe('last line');
  });
});

describe.runIf(process.platform !== 'win32')('okc.sh through a linked folder', { timeout: 60_000 }, () => {
  it('finds the agent that the real path started when it runs through a link to the root, and keeps its pid file', async () => {
    const c = await makeCase('Linux');
    const links = mkdtempSync(join(tmpdir(), 'okc-link-'));
    extra.push(links);
    const linked = join(links, 'repo');
    symlinkSync(c.root, linked);
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    const pid = agentPid(c);
    const status = await run(c, join(linked, 'scripts', 'okc.sh'), ['status']);
    expect(status.out.split('\n')[0]).toBe(`running (pid ${pid})`);
    expect(read(join(c.root, 'data', 'okc.node.pid')).trim()).toBe(String(pid));
    expect((await run(c, join(linked, 'scripts', 'okc.sh'), ['stop'])).out).toBe('ok computer stopped.');
    await waitFor(() => !alive(pid), 5_000);
  });

  // an agent that an older okc started through the link has the linked path in its command line.
  it('finds an agent whose command line names the root through a link', async () => {
    const c = await makeCase('Linux');
    const links = mkdtempSync(join(tmpdir(), 'okc-link-'));
    extra.push(links);
    const linked = join(links, 'repo with space');
    symlinkSync(c.root, linked);
    const child = spawn(process.execPath, [join(linked, 'dist', 'main.js')], { cwd: c.root, env: c.env, stdio: 'ignore' });
    await waitFor(answers(c));
    writeFileSync(join(c.root, 'data', 'okc.node.pid'), String(child.pid));
    expect((await okc(c, ['status'])).out.split('\n')[0]).toBe(`running (pid ${child.pid})`);
    expect((await okc(c, ['stop'])).out).toBe('ok computer stopped.');
    await waitFor(() => !alive(child.pid!), 5_000);
  });
});
