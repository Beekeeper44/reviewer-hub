import crypto from 'node:crypto';
import { getUser } from './db.js';

const COOKIE = 'rh_session';
const MAX_AGE = 60 * 60 * 24 * 30;   // 30 days

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
  const [body, mac = ''] = token.split('.');
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch (e) { return null; }
}

/* ---------- passwords (scrypt, no extra packages) ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64url') + '$' + key.toString('base64url');
}
export function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, k] = stored.split('$');
  const want = Buffer.from(k, 'base64url');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64url'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

/* ---------- invite tokens: only a hash is stored ---------- */
export function newToken() { return crypto.randomBytes(24).toString('base64url'); }
export function tokenHash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

/* ---------- sessions ---------- */
export function setSession(res, email, name, ver) {
  const token = sign({ email, name, v: ver || 0, exp: Math.floor(Date.now() / 1000) + MAX_AGE });
  res.setHeader('Set-Cookie',
    COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + MAX_AGE);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
}
function rawSession(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.indexOf(COOKIE + '=') === 0);
  return hit ? verify(hit.slice(COOKIE.length + 1)) : null;
}

// A session only counts while the person is still on the team and hasn't reset their password.
// Checked against the database, cached briefly so every request isn't a query.
const live = new Map();
export async function readSession(req) {
  const s = rawSession(req);
  if (!s) return null;
  const k = s.email + '|' + s.v;
  const c = live.get(k);
  if (c && c.until > Date.now()) return c.ok ? s : null;
  let ok = false;
  try {
    const u = await getUser(s.email);
    ok = !!u && !!u.pw_hash && u.sess_ver === s.v;
  } catch (e) { ok = false; }
  live.set(k, { ok, until: Date.now() + 30000 });
  return ok ? s : null;
}
export function requireUser(handler) {
  return async function (req, res) {
    const who = await readSession(req);
    if (!who) { res.status(401).json({ error: 'Not signed in' }); return; }
    return handler(req, res, who);
  };
}
export function niceName(email) {
  return String(email).split('@')[0].replace(/[._-]+/g, ' ')
    .replace(/(^| )(.)/g, m => m.toUpperCase());
}
export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const t = String(req.body || '');
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch (e) { return {}; } }
  return Object.fromEntries(new URLSearchParams(t));
}
