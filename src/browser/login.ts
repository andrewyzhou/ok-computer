import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.js';
import { hardenProfile, profileBusy } from './worker.js';

const CHROME_PATHS = [
  join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
];

export interface LoginDeps {
  dataDir: string;
  url?: string;
  chrome?: string;
  launch?: (chrome: string, args: string[]) => Promise<number | null>;
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
  const chrome = deps.chrome ?? CHROME_PATHS.find((path) => existsSync(path));
  if (!chrome) return 'Chrome is not installed in a usual place, so the agent browser cannot open.';
  if (profileBusy(profile)) {
    return 'The agent browser profile is open now, in the agent or in another login window. The agent closes it 10 minutes after its last browser action. Try again then, or run okc stop first.';
  }
  hardenProfile(profile, resolve(deps.dataDir, 'browser', 'downloads'));
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...(deps.url ? [deps.url] : [])];
  await (deps.launch ?? launchChrome)(chrome, args);
  return 'The agent browser closed. The sign-ins are saved in its profile.';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(loaded.error);
    process.exit(1);
  }
  process.stdout.write('Sign in to the sites that the agent may use, then close the Chrome window.\n');
  browserLogin({ dataDir: loaded.value.paths.data, ...(process.argv[2] ? { url: process.argv[2] } : {}) }).then(
    (text) => process.stdout.write(`${text}\n`),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
