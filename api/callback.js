import { setSession, allowedDomain, isBootAdmin, niceName } from '../lib/auth.js';
import { roster, addUser, setUserRole } from '../lib/db.js';

function fail(res, msg) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(403).send(
    '<div style="max-width:560px;margin:64px auto;padding:0 22px;font-family:system-ui;line-height:1.65">' +
    '<h2>Could not sign you in</h2><p style="color:#5c6a61">' + msg + '</p>' +
    '<p><a href="/api/login">Try again</a></p></div>');
}

export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return fail(res, 'Google did not send an authorisation code back.');
  try {
    const base = 'https://' + req.headers.host;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: base + '/api/callback',
        grant_type: 'authorization_code'
      })
    });
    const tok = await r.json();
    if (!tok.id_token) return fail(res, 'Google rejected the sign in. Check the client ID, secret and redirect URI.');

    // The id_token comes straight from Google over TLS, so reading the claims is enough here.
    const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
    const email = String(claims.email || '').toLowerCase();
    if (!email || claims.email_verified === false) return fail(res, 'That Google account has no verified email address.');
    if (!allowedDomain(email)) {
      return fail(res, 'Review Hub is limited to ' + process.env.ALLOWED_DOMAIN +
        ' accounts. You signed in as ' + email + '.');
    }

    const name = claims.name || niceName(email);
    const all = await roster();
    const known = all.some(function (u) { return u.id === email; });
    if (!known) {
      const role = (isBootAdmin(email) || all.length === 0) ? 'admin' : 'reviewer';
      await addUser(email, name, role);
    } else if (isBootAdmin(email)) {
      await setUserRole(email, 'admin');
    }
    setSession(res, email, name);
    res.redirect(302, '/');
  } catch (e) {
    fail(res, 'Something went wrong talking to Google: ' + (e && e.message));
  }
}
