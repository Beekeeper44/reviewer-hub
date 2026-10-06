import { setSession, hashPassword, tokenHash, readBody } from '../lib/auth.js';
import { getUser, findInvite, useInvite, setPassword } from '../lib/db.js';
import { page, esc } from '../lib/page.js';

function form(res, t, u, err) {
  page(res, 'Join', `
<h1>${u.pw_hash ? 'Set a new password' : 'Join Review Hub'}</h1>
<p class="sub">You were invited as <b>${esc(u.email)}</b>.</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/api/invite">
  <input type="hidden" name="t" value="${esc(t)}">
  <input type="hidden" name="username" autocomplete="username" value="${esc(u.email)}">
  <label for="n">Your name</label><input id="n" name="name" required value="${esc(u.name)}">
  <label for="p">Choose a password</label><input id="p" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="p2">Type it again</label><input id="p2" name="password2" type="password" autocomplete="new-password" minlength="10" required>
  <button>${u.pw_hash ? 'Save and sign in' : 'Join'}</button>
</form>
<p class="note">After this, sign in any time with your email and this password.</p>`, err ? 400 : 200);
}
function dead(res) {
  page(res, 'Link expired', `<h1>This link doesn't work</h1>
<p class="sub">It has already been used, has expired, or a newer link was sent. Ask an admin for a fresh one.</p>
<p><a href="/api/login">Go to sign in</a></p>`, 410);
}

export default async function handler(req, res) {
  try {
    const b = req.method === 'POST' ? readBody(req) : {};
    const t = String(req.method === 'POST' ? b.t : req.query.t || '');
    const h = tokenHash(t);
    const email = t ? await findInvite(h) : null;
    const u = email ? await getUser(email) : null;
    if (!u) return dead(res);
    if (req.method !== 'POST') return form(res, t, u);

    const name = String(b.name || '').trim().slice(0, 60) || u.name;
    const pw = String(b.password || '');
    if (pw.length < 10) return form(res, t, { ...u, name }, 'Use at least 10 characters.');
    if (pw !== String(b.password2 || '')) return form(res, t, { ...u, name }, "The two passwords don't match.");

    await setPassword(u.email, name, hashPassword(pw));
    await useInvite(h);
    const fresh = await getUser(u.email);
    setSession(res, u.email, name, fresh.sess_ver);
    res.redirect(302, '/');
  } catch (e) {
    page(res, 'Error', `<h1>Something went wrong</h1><p class="err">${esc(e && e.message)}</p>`, 500);
  }
}
