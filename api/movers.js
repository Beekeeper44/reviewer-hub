import { requireUser } from '../lib/auth.js';
import { kvGet, kvSet, roster } from '../lib/db.js';
import { addImages } from '../lib/images.js';
import { pokemonRows } from '../lib/public-pokemon.js';

// Risers & Fallers feed.
//
// This endpoint does not scrape anyone. It reads a JSON feed you point it at with
// MOVERS_SOURCE_URL (plus an optional MOVERS_SOURCE_TOKEN sent as a Bearer token),
// ranks it, and hands the page a small, stable shape. The feed can come from anywhere
// you're allowed to use: Arena Club's own sales data (a Metabase or Snowflake export),
// a licensed provider, or Alt if you have an agreement with them.
//
// Expected source shape: an array of rows (or { rows: [...] }), one per player or character:
//   {
//     "category": "baseball" | "basketball" | "football" | "pokemon" | "onepiece",
//     "name":     "Player or character name",
//     "image":    "https://...",           optional
//     "url":      "https://...",           optional, opened on click
//     "change30": 68.67,                   percent change over 30 days
//     "volume30": 412,                     cards sold over 30 days
//     "spark":    [ ...90 daily values ]   optional, drawn as the 90-day trend
//   }

const CATS = [
  { id: 'baseball',   label: 'Baseball',   kind: 'players' },
  { id: 'basketball', label: 'Basketball', kind: 'players' },
  { id: 'football',   label: 'Football',   kind: 'players' },
  { id: 'pokemon',    label: 'Pokémon',    kind: 'characters' },
  { id: 'onepiece',   label: 'One Piece',  kind: 'characters' },
];
const ALIASES = { 'one piece': 'onepiece', 'one-piece': 'onepiece', 'pokémon': 'pokemon', 'pkmn': 'pokemon' };

// A 60% move on three sales is noise. Ignore anything below this many sales in 30 days,
// then rank by % change with a light volume weight so heavily traded names win ties.
const MIN_VOLUME = Number(process.env.MOVERS_MIN_VOLUME || 3);
const TOP = 10;

// Speed: the heavy work (Metabase over 100k+ cards, public data, picture lookups) never runs while
// someone waits. It runs on a schedule (vercel.json "crons") and the result is saved to Postgres.
// Page loads just read that saved snapshot, which takes tens of milliseconds.
const SNAP = 'sys:movers:snapshot';
let memo = null;                                   // per-instance copy of the snapshot
const MEMO_TTL = 60 * 1000;

function catOf(v) {
  const k = String(v || '').trim().toLowerCase();
  return ALIASES[k] || k;
}
function score(r) {
  return r.change30 * (1 + Math.log10(Math.max(1, r.volume30)) / 10);
}
function lowerKeys(r) {
  const o = {};
  for (const k of Object.keys(r || {})) o[k.toLowerCase()] = r[k];
  return o;
}
function clean(r) {
  let sp = r.spark;
  if (typeof sp === 'string') { try { sp = JSON.parse(sp); } catch (e) { sp = []; } }
  const spark = Array.isArray(sp) ? sp.map(Number).filter(Number.isFinite) : [];
  return {
    name: String(r.name || '').slice(0, 80),
    image: typeof r.image === 'string' && /^https:\/\//.test(r.image) ? r.image : '',
    url: typeof r.url === 'string' && /^https:\/\//.test(r.url) ? r.url : '',
    change30: Number(r.change30),
    volume30: Math.round(Number(r.volume30) || 0),
    spark: spark.length > 120 ? spark.slice(-120) : spark,
  };
}

async function fromFeed() {
  // Default: the Risers & Fallers question in Arena Club's Metabase (sql/movers.sql).
  // MOVERS_SOURCE_URL in Vercel overrides it. The API key is never in code.
  const src = process.env.MOVERS_SOURCE_URL || 'https://arena-club.metabaseapp.com/api/card/43429/query/json';
  if (/metabaseapp\.com/.test(src) && !process.env.MOVERS_METABASE_API_KEY) return null;
  const headers = { accept: 'application/json' };
  if (process.env.MOVERS_SOURCE_TOKEN) headers.authorization = 'Bearer ' + process.env.MOVERS_SOURCE_TOKEN;
  // Metabase saved question: POST <metabase>/api/card/<id>/query/json with an API key (stays private,
  // no public link needed). Anything else is fetched with GET.
  const isMetabase = /\/api\/card\/\d+\/query\/json/.test(src);
  if (process.env.MOVERS_METABASE_API_KEY) headers['x-api-key'] = process.env.MOVERS_METABASE_API_KEY;
  const r = await fetch(src, isMetabase ? { method: 'POST', headers } : { headers });
  if (!r.ok) throw new Error('source returned ' + r.status);
  const d = await r.json();
  return (Array.isArray(d) ? d : (d.rows || d.data || [])).map(lowerKeys);
}

// Where each category's numbers come from, shown under the lists.
const PUBLIC_NOTE = {
  pokemon: 'Public data: Cardmarket average sold prices via the Pokémon TCG API. Sales column = cards with sales in the last 30 days.',
};
const NO_PUBLIC = 'There is no free public sales feed for this category. Connect Arena Club comps (sql/movers.sql) or a SportsCardsPro / PriceCharting API key.';

async function build() {
  let rows = [], notes = {}, errors = [];
  try { const f = await fromFeed(); if (f) rows = f; } catch (e) { errors.push(String(e.message || e)); }
  const fed = new Set(rows.map(x => catOf(x.category)));

  // Free public data fills any category the feed doesn't cover.
  if (!fed.has('pokemon') && process.env.MOVERS_PUBLIC !== 'off') {
    try { rows = rows.concat(await pokemonRows()); notes.pokemon = PUBLIC_NOTE.pokemon; }
    catch (e) { errors.push('Pokémon public data: ' + (e.message || e)); }
  }

  const categories = CATS.map(c => {
    const pool = rows.filter(x => catOf(x.category) === c.id).map(clean)
      .filter(x => x.name && Number.isFinite(x.change30) &&
        x.volume30 >= (notes[c.id] ? 1 : MIN_VOLUME));
    const up = pool.filter(x => x.change30 > 0).sort((a, b) => score(b) - score(a)).slice(0, TOP);
    const down = pool.filter(x => x.change30 < 0).sort((a, b) => score(a) - score(b)).slice(0, TOP);
    return { id: c.id, label: c.label, kind: c.kind, risers: up, fallers: down,
      volLabel: notes[c.id] ? 'cards' : 'sales',
      note: notes[c.id] || (pool.length ? '' : NO_PUBLIC) };
  });
  if (!categories.some(c => c.risers.length || c.fallers.length))
    return { ok: false, why: errors.length ? errors.join(' · ') : 'no-source' };
  await Promise.all(categories.map(c => addImages([...c.risers, ...c.fallers], c.id)));
  return { ok: true, asOf: new Date().toISOString(), minVolume: MIN_VOLUME, categories };
}

export async function rebuild() {
  const body = await build();
  body.builtAt = new Date().toISOString();
  if (body.ok) await kvSet(SNAP, JSON.stringify(body));   // a failed build never replaces good data
  memo = null;
  return body;
}
async function snapshot() {
  if (memo && Date.now() - memo.at < MEMO_TTL) return memo.body;
  const raw = await kvGet(SNAP);
  const body = raw ? JSON.parse(raw) : null;
  if (body) memo = { at: Date.now(), body };
  return body;
}

export default requireUser(async function (req, res, who) {
  try {
    let body = null;
    const wantRebuild = req.query && req.query.rebuild === '1';
    if (wantRebuild) {
      const me = (await roster()).find(u => u.id === who.email);
      if (!me || me.role !== 'admin') { res.status(403).json({ ok: false, why: 'Only an admin can rebuild.' }); return; }
      body = await rebuild();
      if (!body.ok) body = Object.assign((await snapshot()) || {}, { rebuildError: body.why }) ;
    } else {
      body = await snapshot();
      if (!body) body = await rebuild();           // very first time only
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).json(body);
  } catch (e) {
    res.status(200).json({ ok: false, why: String(e && e.message || e) });
  }
});
