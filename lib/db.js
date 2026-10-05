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
  const { rows } = await db().query('SELECT email, name, role FROM users ORDER BY added ASC');
  return rows.map(function (r) { return { id: r.email, name: r.name, role: r.role }; });
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
