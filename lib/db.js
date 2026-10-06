import { Pool } from 'pg';

let pool;
export function db() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3
    });
  }
  return pool;
}

let ready = false;
export async function init() {
  if (ready) return;
  await db().query(`
    CREATE TABLE IF NOT EXISTS kv (
      key     text PRIMARY KEY,
      value   text NOT NULL,
      updated timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      email text PRIMARY KEY,
      name  text NOT NULL,
      role  text NOT NULL DEFAULT 'reviewer',
      added timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pw_hash  text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sess_ver integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS invites (
      token_hash text PRIMARY KEY,
      email      text NOT NULL,
      expires    timestamptz NOT NULL,
      used       timestamptz
    );
  `);
  ready = true;
}

/* Some keys belong to one person rather than the team. */
const PERSONAL = ['align:font', 'align:theme', 'align:ticker', 'align:mobilepreview', 'align:meId'];
export function scope(key, email) {
  return PERSONAL.includes(key) ? (email + '|' + key) : key;
}

export async function kvGet(key) {
  await init();
  const { rows } = await db().query('SELECT value FROM kv WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}
export async function kvSet(key, value) {
  await init();
  await db().query(
    'INSERT INTO kv (key, value, updated) VALUES ($1, $2, now())' +
    ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated = now()',
    [key, value]);
}
export async function kvDel(key) {
  await init();
  await db().query('DELETE FROM kv WHERE key = $1', [key]);
}
export async function roster() {
  await init();
  const { rows } = await db().query('SELECT email, name, role, (pw_hash IS NOT NULL) AS joined FROM users ORDER BY added ASC');
  return rows.map(function (r) { return { id: r.email, name: r.name, role: r.role, joined: r.joined }; });
}
export async function addUser(email, name, role) {
  await init();
  await db().query(
    'INSERT INTO users (email, name, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
    [email, name, role]);
}
export async function setUserRole(email, role) {
  await init();
  await db().query('UPDATE users SET role = $2 WHERE email = $1', [email, role]);
}

/* ---------- accounts and invites ---------- */
export async function getUser(email) {
  await init();
  const { rows } = await db().query('SELECT email, name, role, pw_hash, sess_ver FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}
export async function countAccounts() {
  await init();
  const { rows } = await db().query('SELECT count(*)::int AS n FROM users WHERE pw_hash IS NOT NULL');
  return rows[0].n;
}
export async function setPassword(email, name, pwHash) {
  await init();
  // a new password signs the person out everywhere else
  await db().query('UPDATE users SET pw_hash = $2, name = $3, sess_ver = sess_ver + 1 WHERE email = $1',
    [email, pwHash, name]);
}
export async function removeUser(email) {
  await init();
  await db().query('DELETE FROM invites WHERE email = $1', [email]);
  await db().query('DELETE FROM users WHERE email = $1', [email]);
}
export async function saveInvite(tokenHash, email, days) {
  await init();
  await db().query('DELETE FROM invites WHERE email = $1 AND used IS NULL', [email]);   // only the newest link works
  await db().query("INSERT INTO invites (token_hash, email, expires) VALUES ($1, $2, now() + ($3 || ' days')::interval)",
    [tokenHash, email, String(days)]);
}
export async function findInvite(tokenHash) {
  await init();
  const { rows } = await db().query(
    'SELECT email FROM invites WHERE token_hash = $1 AND used IS NULL AND expires > now()', [tokenHash]);
  return rows[0] ? rows[0].email : null;
}
export async function useInvite(tokenHash) {
  await init();
  await db().query('UPDATE invites SET used = now() WHERE token_hash = $1', [tokenHash]);
}
