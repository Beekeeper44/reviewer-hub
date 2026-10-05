import { requireUser } from '../lib/auth.js';
import { addImages } from '../lib/images.js';

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
const MIN_VOLUME = Number(process.env.MOVERS_MIN_VOLUME || 10);
const TOP = 10;

let memo = null; // { at, body }
const TTL = 10 * 60 * 1000;

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

async function build() {
  const src = process.env.MOVERS_SOURCE_URL;
  if (!src) return { ok: false, why: 'no-source' };
  const headers = { accept: 'application/json' };
  if (process.env.MOVERS_SOURCE_TOKEN) headers.authorization = 'Bearer ' + process.env.MOVERS_SOURCE_TOKEN;
  // Metabase saved question: POST <metabase>/api/card/<id>/query/json with an API key (stays private,
  // no public link needed). Anything else is fetched with GET.
  const isMetabase = /\/api\/card\/\d+\/query\/json/.test(src);
  if (process.env.MOVERS_METABASE_API_KEY) headers['x-api-key'] = process.env.MOVERS_METABASE_API_KEY;
  const r = await fetch(src, isMetabase ? { method: 'POST', headers } : { headers });
  if (!r.ok) throw new Error('source returned ' + r.status);
  const d = await r.json();
  const rows = (Array.isArray(d) ? d : (d.rows || d.data || [])).map(lowerKeys);

  const categories = CATS.map(c => {
    const pool = rows.filter(x => catOf(x.category) === c.id).map(clean)
      .filter(x => x.name && Number.isFinite(x.change30) && x.volume30 >= MIN_VOLUME);
    const up = pool.filter(x => x.change30 > 0).sort((a, b) => score(b) - score(a)).slice(0, TOP);
    const down = pool.filter(x => x.change30 < 0).sort((a, b) => score(a) - score(b)).slice(0, TOP);
    return { id: c.id, label: c.label, kind: c.kind, risers: up, fallers: down };
  });
  await Promise.all(categories.map(c => addImages([...c.risers, ...c.fallers], c.id)));
  return { ok: true, asOf: d.asOf || new Date().toISOString(), minVolume: MIN_VOLUME, categories };
}

export default requireUser(async function (req, res) {
  try {
    if (!memo || Date.now() - memo.at > TTL) memo = { at: Date.now(), body: await build() };
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    res.status(200).json(memo.body);
  } catch (e) {
    res.status(200).json({ ok: false, why: String(e && e.message || e) });
  }
});
