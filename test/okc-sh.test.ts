import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..');
const scripts = join(repo, 'scripts');
const label = 'com.okcomputer.agent';
// macos keeps the bash 3.2 at /bin/bash, and the script must run there.
const bash = '/bin/bash';
const which = (name: string) => spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const realCurl = which('curl');
const realTail = which('tail');

// the fake agent answers the overview with 401, as an agent with a dashboard token does. it ends on a shutdown with
// its token, unless it is stubborn, and then it also ignores sigterm. it ends by itself after a minute in any case.
const fakeAgent = `
const fs = require('node:fs');
const path = require('node:path');
const data = path.join(__dirname, '..', 'data');
const token = require('node:crypto').randomBytes(16).toString('hex');
const stubborn = process.env.FAKE_AGENT === 'stubborn';
fs.writeFileSync(path.join(data, 'okc.stop-token'), token + '\\n');
fs.writeFileSync(path.join(data, 'agent.pid'), String(process.pid));
if (stubborn) process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 60000);
require('node:http').createServer((req, res) => {
  if (req.url === '/api/overview') return res.writeHead(401).end();
  if (req.method !== 'POST' || req.url !== '/api/shutdown') return res.writeHead(404).end();
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let ok = false;
    try { ok = JSON.parse(body).token === token && req.headers['content-type'] === 'application/json'; } catch {}
    fs.appendFileSync(path.join(data, 'shutdown.log'), ok ? 'ok\\n' : 'refused\\n');
    res.writeHead(ok ? 200 : 401).end();
    if (ok && !stubborn) setImmediate(() => process.exit(0));
  });
}).listen(Number(new URL(process.env.OKC_URL).port), '127.0.0.1');
`;

// each stub records its arguments in the record folder of the case. launchctl print fails until a bootstrap made the
// loaded marker, and then shows the pid of launchd.pid when that file exists.
const stubs: Record<string, string> = {
  launchctl: `echo "$*" >> "$STUB_DIR/launchctl.log"
case "$1" in
  print)
    [ -f "$STUB_DIR/loaded" ] || exit 113
    echo "$2 = {"
    if [ -f "$STUB_DIR/launchd.pid" ]; then printf '\\tpid = %s\\n' "$(cat "$STUB_DIR/launchd.pid")"; fi
    echo "}" ;;
  bootstrap) touch "$STUB_DIR/loaded" ;;
  bootout) rm -f "$STUB_DIR/loaded" ;;
esac`,
  open: `echo "$*" >> "$STUB_DIR/open.log"`,
  'xdg-open': `echo "$*" >> "$STUB_DIR/xdg-open.log"`,
  uname: `echo "$STUB_UNAME"`,
  npm: `echo "$*" >> "$STUB_DIR/npm.log"
if [ -n "\${STUB_BUILD_FAIL:-}" ]; then echo 'type error in main.ts' >&2; exit 2; fi
mkdir -p dist && : > dist/.build-ok`,
  curl: `echo "$*" >> "$STUB_DIR/curl.log"
exec '${realCurl}' "$@"`,
  tail: `for arg in "$@"; do if [ "$arg" = -f ]; then echo "$*" >> "$STUB_DIR/tail.log"; exit 0; fi; done
exec '${realTail}' "$@"`,
};

type Case = { root: string; home: string; stub: string; env: NodeJS.ProcessEnv };
const cases: Case[] = [];
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

// each case has its own root with a copy of okc.sh and the template, a fake HOME, a free port and a stub folder first
// on the path. so no command reaches the launchd or the agent of the owner.
async function makeCase(uname: 'Darwin' | 'Linux', name = 'okc-sh-'): Promise<Case> {
  const root = mkdtempSync(join(tmpdir(), name));
  const home = mkdtempSync(join(tmpdir(), 'okc-home-'));
  const stub = mkdtempSync(join(tmpdir(), 'okc-stub-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'data'));
  copyFileSync(join(scripts, 'okc.sh'), join(root, 'scripts', 'okc.sh'));
  cpSync(join(scripts, 'macos'), join(root, 'scripts', 'macos'), { recursive: true });
  writeFileSync(join(root, 'dist', 'main.js'), fakeAgent);
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

function okc(c: Case, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; out: string }> {
  const child = spawn(bash, [join(c.root, 'scripts', 'okc.sh'), ...args], { env: { ...c.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (out += chunk));
  return new Promise((done) => child.on('close', (status) => done({ status, out: out.trim() })));
}

// the functions run in a shell that sources the script, so the dispatcher does not run.
function sourced(c: Case, body: string): string {
  const result = spawnSync(bash, ['-c', 'source "$1"; eval "$2"', '_', join(c.root, 'scripts', 'okc.sh'), body], { env: c.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
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

// the fake agents end by themselves after a minute, but a failed case should not leave one for that long.
afterEach(() => {
  for (const c of cases.splice(0)) {
    const pid = agentPid(c);
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    for (const dir of [c.root, c.home, c.stub]) rmSync(dir, { recursive: true, force: true });
  }
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

describe.runIf(process.platform !== 'win32')('okc.sh', { timeout: 60_000 }, () => {
  it('passes bash -n, and shellcheck when it is installed', () => {
    expect(spawnSync(bash, ['-n', join(scripts, 'okc.sh')]).status).toBe(0);
    if (which('shellcheck')) {
      const result = spawnSync('shellcheck', [join(scripts, 'okc.sh')], { encoding: 'utf8' });
      expect(result.stdout).toBe('');
    }
  });

  // tsc writes its output also when the types are wrong, so the stamp alone tells that the build ended well. a new or
  // deleted file changes only the time of its folder.
  it('builds again without a stamp, after a change of an input, and after a new folder', async () => {
    const c = await makeCase('Linux');
    const old = () => sourced(c, 'if build_is_old; then echo old; else echo fresh; fi');
    const before = new Date(Date.now() - 7_200_000);
    const built = new Date(Date.now() - 3_600_000);
    mkdirSync(join(c.root, 'src', 'db'), { recursive: true });
    const inputs = ['src/main.ts', 'src/db/001_a.sql', 'package-lock.json'];
    for (const file of inputs) writeFileSync(join(c.root, file), 'x');
    for (const path of [...inputs, 'src/db', 'src']) utimesSync(join(c.root, path), before, before);

    expect(old()).toBe('old');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    utimesSync(join(c.root, 'dist', '.build-ok'), built, built);
    expect(old()).toBe('fresh');
    writeFileSync(join(c.root, 'package-lock.json'), 'y');
    expect(old()).toBe('old');
    utimesSync(join(c.root, 'package-lock.json'), before, before);
    expect(old()).toBe('fresh');
    mkdirSync(join(c.root, 'src', 'db', 'migrations'));
    expect(old()).toBe('old');
  });

  // the live folder points its data at the repository, and the agent writes the stop token there.
  it('reads the stop token from the data folder of the config', async () => {
    const c = await makeCase('Linux', 'okc sh with spaces-');
    const path = () => sourced(c, 'agent_data_path; echo "$agent_data"');
    expect(path()).toBe(join(c.root, 'data'));
    writeFileSync(join(c.root, 'okc.config.json'), JSON.stringify({ paths: { data: 'state' } }));
    expect(path()).toBe(join(c.root, 'state'));
    writeFileSync(join(c.root, 'okc.config.json'), JSON.stringify({ paths: { data: '/elsewhere/data' } }));
    expect(path()).toBe('/elsewhere/data');
    writeFileSync(join(c.root, 'okc.config.json'), '{ not json');
    expect(path()).toBe(`okc.config.json is not valid json, so the stop token is read from ${join(c.root, 'data')}.\n${join(c.root, 'data')}`);
  });

  it('starts the agent once, and tells the owner to restart when the code on disk is newer', async () => {
    const c = await makeCase('Linux', 'okc sh root-');
    const started = await okc(c, ['start', '--no-open']);
    expect(started).toEqual({ status: 0, out: 'building...\nok computer started.' });
    expect(read(join(c.stub, 'npm.log'))).toBe('run build --silent\n');
    await waitFor(answers(c));
    const pid = agentPid(c);
    expect(read(join(c.root, 'data', 'okc.node.pid')).trim()).toBe(String(pid));
    expect(read(join(c.root, 'data', 'logs', 'launcher.log'))).toContain('ok computer started.');

    // the second start opens the dashboard, and xdg-open is the opener of linux.
    expect(await okc(c, ['start'])).toEqual({ status: 0, out: 'ok computer is already running.' });
    expect(read(join(c.stub, 'xdg-open.log'))).toBe(`${c.env.OKC_URL}\n`);
    expect(read(join(c.stub, 'npm.log'))).toBe('run build --silent\n');

    const later = new Date(Date.now() + 5_000);
    utimesSync(join(c.root, 'dist', '.build-ok'), later, later);
    const warned = await okc(c, ['start', '--no-open']);
    expect(warned.out).toBe('ok computer is already running.\nthe code on disk is newer than the running agent. run okc restart to load it.');
    rmSync(join(c.root, 'dist', '.build-ok'));
    expect((await okc(c, ['start', 'now', '--no-open'])).out).toContain('run okc restart to load it.');
    expect(alive(pid)).toBe(true);
  });

  // the shell of a login agent has no terminal, so a failed build showed nothing and left no trace.
  it('keeps the reason of a failed build in the launcher log', async () => {
    const c = await makeCase('Linux');
    const result = await okc(c, ['start', '--no-open'], { STUB_BUILD_FAIL: '1' });
    expect(result.status).toBe(1);
    const log = read(join(c.root, 'data', 'logs', 'launcher.log'));
    expect(log).toContain('type error in main.ts');
    expect(log).toContain('error: the build failed.');
    expect(existsSync(join(c.root, 'data', 'okc.node.pid'))).toBe(false);
  });

  // ps shows the command line of each process to every user, so the token goes to curl on stdin.
  it('stops the agent through the shutdown request, without the token on a command line', async () => {
    const c = await makeCase('Darwin');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    const pid = agentPid(c);
    const token = read(join(c.root, 'data', 'okc.stop-token')).trim();

    expect(await okc(c, ['stop'])).toEqual({ status: 0, out: 'ok computer stopped.' });
    expect(alive(pid)).toBe(false);
    expect(read(join(c.root, 'data', 'shutdown.log'))).toBe('ok\n');
    expect(read(join(c.stub, 'curl.log'))).toContain('/api/shutdown');
    expect(read(join(c.stub, 'curl.log'))).not.toContain(token);
    expect(read(join(c.root, 'data', 'logs', 'launcher.log'))).not.toContain(token);
    expect(existsSync(join(c.root, 'data', 'okc.node.pid'))).toBe(false);
    expect((await okc(c, ['stop'])).out).toBe('ok computer is not running.');
  });

  it('stops an agent that ignores the shutdown and sigterm by force', async () => {
    const c = await makeCase('Linux');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    await okc(c, ['start', '--no-open'], { FAKE_AGENT: 'stubborn' });
    await waitFor(answers(c));
    const pid = agentPid(c);
    expect(await okc(c, ['stop'])).toEqual({ status: 0, out: 'the agent did not stop by itself, so okc stops it.\nok computer stopped.' });
    expect(read(join(c.root, 'data', 'shutdown.log'))).toBe('ok\n');
    await waitFor(() => !alive(pid), 2_000);
  });

  it('stops the agent at once when there is no stop token', async () => {
    const c = await makeCase('Linux');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    const pid = agentPid(c);
    rmSync(join(c.root, 'data', 'okc.stop-token'));
    const begin = Date.now();
    expect((await okc(c, ['stop'])).out).toBe('the agent did not stop by itself, so okc stops it.\nok computer stopped.');
    expect(Date.now() - begin).toBeLessThan(5_000);
    expect(existsSync(join(c.root, 'data', 'shutdown.log'))).toBe(false);
    await waitFor(() => !alive(pid), 2_000);
  });

  // a stale pid can belong to any process, which okc stop then ended.
  it('deletes a pid file with junk or with the pid of another process', async () => {
    const c = await makeCase('Linux');
    const pidFile = join(c.root, 'data', 'okc.node.pid');
    for (const text of ['', 'junk', '12 34', String(process.pid)]) {
      writeFileSync(pidFile, text);
      expect((await okc(c, ['status'])).out.split('\n')[0]).toBe('not running');
      expect(existsSync(pidFile)).toBe(false);
    }
    writeFileSync(pidFile, String(process.pid));
    expect((await okc(c, ['stop'])).out).toBe('ok computer is not running.');
    expect(alive(process.pid)).toBe(true);
  });

  it('shows whether the agent runs, whether the dashboard answers, and the last errors of launchd', async () => {
    const c = await makeCase('Linux');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    expect((await okc(c, ['status'])).out).toBe('not running\ndashboard: not reachable');
    await okc(c, ['start', '--no-open']);
    await waitFor(answers(c));
    mkdirSync(join(c.root, 'data', 'logs'), { recursive: true });
    writeFileSync(join(c.root, 'data', 'logs', 'launchd.err.log'), 'one\ntwo\nthree\nfour\n');
    const status = await okc(c, ['status']);
    expect(status.out).toBe(`running (pid ${agentPid(c)})\ndashboard: ${c.env.OKC_URL}\nlast errors:\ntwo\nthree\nfour`);
  });

  // launchd starts the agent, so its pid comes from launchctl and not from the pid file.
  it('finds and stops an agent that launchd started', async () => {
    const c = await makeCase('Darwin');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    mkdirSync(join(c.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(c.home, 'Library', 'LaunchAgents', `${label}.plist`), '');
    const child = spawn(process.execPath, [join(c.root, 'dist', 'main.js')], { cwd: c.root, env: c.env, stdio: 'ignore' });
    children.push(child);
    await waitFor(answers(c));
    writeFileSync(join(c.stub, 'loaded'), '');
    writeFileSync(join(c.stub, 'launchd.pid'), String(child.pid));
    expect((await okc(c, ['status'])).out).toBe(`running (pid ${child.pid})\ndashboard: ${c.env.OKC_URL}`);
    expect(await okc(c, ['stop'])).toEqual({ status: 0, out: 'ok computer stopped.' });
    await waitFor(() => child.exitCode !== null, 2_000);
    expect(child.exitCode).toBe(0);
    expect(read(join(c.stub, 'launchctl.log'))).not.toContain('bootout');
  });

  it('follows the newest okc log', async () => {
    const c = await makeCase('Linux');
    expect((await okc(c, ['logs'])).out).toBe('no logs yet.');
    const logs = join(c.root, 'data', 'logs');
    mkdirSync(logs, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    for (const name of ['okc-2026-10-01.log', 'okc-2026-10-02.log', 'launcher.log', 'launchd.err.log']) writeFileSync(join(logs, name), 'x');
    utimesSync(join(logs, 'okc-2026-10-02.log'), past, past);
    utimesSync(join(logs, 'launcher.log'), past, past);
    await okc(c, ['logs']);
    expect(read(join(c.stub, 'tail.log'))).toBe(`-n 40 -f ${join(logs, 'okc-2026-10-01.log')}\n`);
  });

  it('runs the browser login with its url, and says how to use it', async () => {
    const c = await makeCase('Linux');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    mkdirSync(join(c.root, 'dist', 'browser'));
    writeFileSync(join(c.root, 'dist', 'browser', 'login.js'), "console.log(['login', ...process.argv.slice(2)].join(' '));\n");
    expect((await okc(c, ['browser'])).out).toBe('usage: okc browser login [url]');
    expect((await okc(c, ['browser', 'login'])).out).toBe('login');
    expect((await okc(c, ['browser', 'login', 'https://example.test/a b'])).out).toBe('login https://example.test/a b');
    expect(existsSync(join(c.stub, 'npm.log'))).toBe(false);
  });

  // the values of the plist are xml, so a root with & or < must not break it.
  it('installs the login agent under a fake home and removes it again', async () => {
    const c = await makeCase('Darwin', 'okc sh & <root>-');
    const result = await okc(c, ['install']);
    expect(result).toEqual({ status: 0, out: `building...\ninstalled: okc command and the ${label} login agent.` });
    const plist = join(c.home, 'Library', 'LaunchAgents', `${label}.plist`);
    const text = read(plist);
    const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const node = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: c.env, encoding: 'utf8' }).stdout.trim();
    expect(node.startsWith('/')).toBe(true);
    expect(text).toContain(`<string>${xml(node)}</string>`);
    expect(text).toContain(`<string>${xml(c.root)}/dist/main.js</string>`);
    expect(text).toContain(`<key>WorkingDirectory</key>\n  <string>${xml(c.root)}</string>`);
    expect(text).toContain(`<string>${dirname(node)}:/opt/homebrew/bin:`);
    expect(text).toContain(`<string>${xml(join(c.root, 'data', 'logs'))}/launchd.err.log</string>`);
    for (const place of ['@@NODE@@', '@@ROOT@@', '@@PATH@@', '@@LOGS@@']) expect(text).not.toContain(place);
    expect(text).not.toContain(c.root);
    expect(existsSync(join(c.root, 'data', 'logs'))).toBe(true);
    if (existsSync('/usr/bin/plutil')) expect(spawnSync('/usr/bin/plutil', ['-lint', plist]).status).toBe(0);
    const uid = process.getuid!();
    expect(read(join(c.stub, 'launchctl.log'))).toContain(`bootstrap gui/${uid} ${plist}\n`);
    const command = join(c.home, '.local', 'bin', 'okc');
    expect(readlinkSync(command)).toBe(join(c.root, 'scripts', 'okc.sh'));

    // a start under launchd loads or kicks the job, and runs no agent of its own.
    expect((await okc(c, ['start', '--no-open'])).out).toBe('ok computer started.');
    expect(read(join(c.stub, 'launchctl.log'))).toContain(`kickstart gui/${uid}/${label}\n`);
    expect(existsSync(join(c.root, 'data', 'okc.node.pid'))).toBe(false);

    expect(await okc(c, ['uninstall'])).toEqual({ status: 0, out: 'ok computer is not running.\nuninstalled.' });
    expect(read(join(c.stub, 'launchctl.log'))).toContain(`bootout gui/${uid}/${label}\n`);
    expect(existsSync(plist)).toBe(false);
    expect(() => lstatSync(command)).toThrow();
  });

  it('installs only the command on linux', async () => {
    const c = await makeCase('Linux');
    writeFileSync(join(c.root, 'dist', '.build-ok'), '');
    expect((await okc(c, ['install'])).out).toBe('installed: okc command. linux has no login agent yet, so run okc start after you sign in.');
    expect(readlinkSync(join(c.home, '.local', 'bin', 'okc'))).toBe(join(c.root, 'scripts', 'okc.sh'));
    expect(existsSync(join(c.home, 'Library'))).toBe(false);
    expect(existsSync(join(c.stub, 'launchctl.log'))).toBe(false);

    // a link to another script is not ours to remove.
    rmSync(join(c.home, '.local', 'bin', 'okc'));
    spawnSync('ln', ['-s', '/elsewhere/okc.sh', join(c.home, '.local', 'bin', 'okc')]);
    expect((await okc(c, ['uninstall'])).out).toBe('ok computer is not running.\nuninstalled.');
    expect(readlinkSync(join(c.home, '.local', 'bin', 'okc'))).toBe('/elsewhere/okc.sh');
  });
});
