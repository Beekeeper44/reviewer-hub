import crypto from 'node:crypto';

const COOKIE = 'rh_session';
const MAX_AGE = 60 * 60 * 24 * 14;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET is missing or too short');
  return s;
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const parts = token.split('.');
  const body = parts[0], mac = parts[1] || '';
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch (e) { return null; }
}
export function setSession(res, email, name) {
  const token = sign({ email: email, name: name, exp: Math.floor(Date.now()/1000) + MAX_AGE });
  res.setHeader('Set-Cookie',
    COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + MAX_AGE);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
}
export function readSession(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(function (s) { return s.trim(); })
    .find(function (s) { return s.indexOf(COOKIE + '=') === 0; });
  return hit ? verify(hit.slice(COOKIE.length + 1)) : null;
}
export function requireUser(handler) {
  return async function (req, res) {
    const who = readSession(req);
    if (!who) { res.status(401).json({ error: 'Not signed in' }); return; }
    return handler(req, res, who);
  };
}
export function allowedDomain(email) {
  const d = (process.env.ALLOWED_DOMAIN || '').trim().toLowerCase();
  if (!d) return true;
  return String(email).toLowerCase().endsWith('@' + d);
}
export function isBootAdmin(email) {
  return (process.env.ADMIN_EMAILS || '').split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean).indexOf(String(email).toLowerCase()) >= 0;
}
export function niceName(email) {
  return String(email).split('@')[0].replace(/[._-]+/g, ' ')
    .replace(/(^| )(.)/g, function (m) { return m.toUpperCase(); });
}
