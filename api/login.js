import crypto from 'node:crypto';
import { setSession, hashPassword, checkPassword, readBody, niceName } from '../lib/auth.js';
import { getUser, countAccounts, addUser, setPassword, setUserRole } from '../lib/db.js';
import { page, esc } from '../lib/page.js';

// Slow down password guessing: 8 tries per address per 15 minutes on each server instance.
const tries = new Map();
function limited(email) {
  const now = Date.now(), t = (tries.get(email) || []).filter(x => now - x < 15 * 60000);
  tries.set(email, t);
  return t.length >= 8;
}
function note(email) { (tries.get(email) || tries.set(email, []).get(email)).push(Date.now()); }

function signInForm(res, err, email) {
  page(res, 'Sign in', `
<h1>Sign in</h1><p class="sub">Use the email and password from your invite.</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/api/login">
  <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" required value="${esc(email)}">
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
  <button>Sign in</button>
</form>
<p class="note">Forgot your password or need access? Ask an admin for a new invite link.</p>`, err ? 400 : 200);
}

function setupForm(res, err, v) {
  v = v || {};
  page(res, 'Set up', `
<h1>Set up Review Hub</h1><p class="sub">No accounts yet. Create the first admin, then invite the team from inside.</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/api/login">
  <input type="hidden" name="mode" value="setup">
  <label for="n">Your name</label><input id="n" name="name" required value="${esc(v.name)}">
  <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" required value="${esc(v.email)}">
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="c">Setup code</label><input id="c" name="code" type="password" required>
  <p class="note" style="margin-top:6px">The setup code is your <b>SESSION_SECRET</b> from Vercel. It's only asked for once, so a stranger can't claim the site before you.</p>
  <button>Create admin account</button>
</form>`, err ? 400 : 200);
}

export default async function handler(req, res) {
  const missing = ['SESSION_SECRET', 'DATABASE_URL'].filter(k => !(process.env[k] || '').trim());
  if (missing.length) {
    return page(res, 'Not set up', `<h1>Not set up yet</h1><p class="sub">Add these in Vercel → Settings →
      Environment Variables (Production), then redeploy:</p><p>${missing.map(k => '<code>' + k + '</code>').join('<br>')}</p>`, 500);
  }
  try {
    const firstRun = (await countAccounts()) === 0;

    if (req.method !== 'POST') return firstRun ? setupForm(res) : signInForm(res, '', req.query.email || '');

    const b = readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const pw = String(b.password || '');

    if (firstRun) {
      const name = String(b.name || '').trim() || niceName(email);
      const code = Buffer.from(String(b.code || '')), want = Buffer.from(process.env.SESSION_SECRET);
      if (code.length !== want.length || !crypto.timingSafeEqual(code, want))
        return setupForm(res, 'That setup code is wrong.', { name, email });
      if (email.indexOf('@') < 1) return setupForm(res, 'Enter a valid email.', { name, email });
      if (pw.length < 10) return setupForm(res, 'Use at least 10 characters for the password.', { name, email });
      await addUser(email, name, 'admin');
      await setUserRole(email, 'admin');
      await setPassword(email, name, hashPassword(pw));
      const u = await getUser(email);
      setSession(res, email, name, u.sess_ver);
      return res.redirect(302, '/');
    }

    if (limited(email)) return signInForm(res, 'Too many tries. Wait 15 minutes and try again.', email);
    const u = await getUser(email);
    if (!u || !u.pw_hash || !checkPassword(pw, u.pw_hash)) {
      note(email);
      return signInForm(res, 'Email or password is wrong.', email);
    }
    tries.delete(email);
    setSession(res, u.email, u.name, u.sess_ver);
    res.redirect(302, '/');
  } catch (e) {
    page(res, 'Error', `<h1>Something went wrong</h1><p class="err">${esc(e && e.message)}</p><p><a href="/api/login">Try again</a></p>`, 500);
  }
}
