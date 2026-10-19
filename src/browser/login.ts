import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.js';
import { openDb } from '../db/index.js';
import { resumeEngines } from '../web/search.js';
import { hardenProfile, profileBusy } from './worker.js';

// the usual places of chrome on each platform. a browser login and the browser tests use the first one that exists.
export function chromePaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    return [
      join(env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    return [join('/Applications', app), join(env.HOME ?? '', 'Applications', app)];
  }
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
}

export const findChrome = () => chromePaths().find((path) => existsSync(path));

export interface LoginDeps {
  dataDir: string;
  url?: string;
  chrome?: string;
  launch?: (chrome: string, args: string[]) => Promise<number | null>;
  // runs when the window closes. the command ends the pauses of the search engines.
  onClosed?: () => void;
}

const launchChrome = (chrome: string, args: string[]) =>
  new Promise<number | null>((done, fail) => {
    const child = spawn(chrome, args, { stdio: 'ignore' });
    child.once('error', fail);
    child.once('exit', done);
  });

// the owner signs in to sites in the agent profile. the window is a plain chrome without automation: sign-in pages
// refuse a browser that playwright controls, and the owner's own browsing needs no gate.
export async function browserLogin(deps: LoginDeps): Promise<string> {
  const profile = resolve(deps.dataDir, 'browser', 'profile');
  const chrome = deps.chrome ?? findChrome();
  if (!chrome) return 'Chrome is not installed in a usual place, so the agent browser cannot open.';
  if (profileBusy(profile)) {
    return 'The agent browser profile is open now, in the agent or in another login window. The agent closes it 10 minutes after its last browser action. Try again then, or run okc stop first.';
  }
  hardenProfile(profile, resolve(deps.dataDir, 'browser', 'downloads'));
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...(deps.url ? [deps.url] : [])];
  await (deps.launch ?? launchChrome)(chrome, args);
  deps.onClosed?.();
  return 'The agent browser closed. The sign-ins are saved in its profile. A paused search engine tries again at the next search.';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(loaded.error);
    process.exit(1);
  }
  // chrome on macos keeps running when its last window closes, so the owner quits it.
  const close = process.platform === 'darwin' ? 'quit Chrome with Command-Q' : 'close the Chrome window';
  process.stdout.write(`Sign in to the sites that the agent may use, then ${close}.\n`);
  const dataDir = loaded.value.paths.data;
  // the owner may have answered a captcha or a consent page of a search engine in the window.
  const onClosed = () => resumeEngines(openDb(join(dataDir, 'okc.sqlite')), new Date());
  browserLogin({ dataDir, onClosed, ...(process.argv[2] ? { url: process.argv[2] } : {}) }).then(
    (text) => process.stdout.write(`${text}\n`),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
