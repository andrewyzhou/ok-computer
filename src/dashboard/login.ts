import { randomBytes } from 'node:crypto';
import type { Clock } from '../time.js';

// a code from /dashboard works one time, for a short time. it goes through telegram, so it must not stay valid.
const CODE_MS = 5 * 60_000;

export interface LoginCodes {
  issue(): string;
  // spend gives true one time for a code that did not expire.
  spend(code: string): boolean;
}

// the codes live in memory, in the process that runs the dashboard. a restart makes every open code invalid.
export function createLoginCodes(clock: Clock): LoginCodes {
  const codes = new Map<string, number>();
  return {
    issue() {
      const now = clock().getTime();
      for (const [code, expires] of codes) if (expires <= now) codes.delete(code);
      const code = randomBytes(16).toString('base64url');
      codes.set(code, now + CODE_MS);
      return code;
    },
    spend(code) {
      const expires = codes.get(code);
      codes.delete(code);
      return expires !== undefined && clock().getTime() < expires;
    },
  };
}

// the page does not spend the code when it loads. a link preview or a scanner can load the page, but only the button
// sends the code, so only the owner signs in with it.
export const LOGIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>OK Computer</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 22rem; margin: 4rem auto; padding: 0 1rem">
<h1 style="font-size: 1.3rem">OK Computer</h1>
<form id="login">
<p id="hint">Sign in with the link from /dashboard, or with the dashboard token.</p>
<label>Dashboard token<br><input id="token" type="password" autocomplete="current-password" style="width: 100%; padding: .4rem"></label>
<p id="error" style="color: #b00020"></p>
<button type="submit" style="padding: .4rem 1rem">Sign in</button>
</form>
<script>
const code = new URLSearchParams(location.search).get('code');
if (code) document.getElementById('hint').textContent = 'Press Sign in. The token is not needed with this link.';
document.getElementById('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = document.getElementById('token').value;
  const body = token ? { token } : { code };
  const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (response.ok) return location.replace('/');
  document.getElementById('error').textContent = token ? 'That token is wrong.' : 'This link does not work any more. Send /dashboard again.';
});
</script></body></html>`;
