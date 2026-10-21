import type { LoginPageView } from './types.js';

// the login page. the server renders it, so it works without the bundle of the web app. it has the dashboard token
// as a fallback, and "Text me a code" when the app can send one (view.textCode).
// the page does not spend a link code of /dashboard when it loads. a link preview or a scanner can load the page, but
// only the button sends the code, so only the owner signs in with it.
export function renderLoginPage(view: LoginPageView): string {
  void view;
  return LEGACY_PAGE;
}

// the page from before track s1. renderLoginPage gives it until its restyle is built.
const LEGACY_PAGE = `<!doctype html>
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
