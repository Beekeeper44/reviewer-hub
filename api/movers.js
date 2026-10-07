import { requireUser } from '../lib/auth.js';
import { kvGet, kvSet, roster } from '../lib/db.js';
import { addImages } from '../lib/images.js';
import { pokemonRows, character } from '../lib/public-pokemon.js';

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
const MIN_VOLUME = Number(process.env.MOVERS_MIN_VOLUME || 3);          // to be searchable in look-ups
// To make the main Risers & Fallers lists a player needs real volume, so the lists are the
// established names (Duncan, Shaq, Iverson...) rather than a 5-sale card hitting the cap.
// If a category is quiet (One Piece, some Pokémon), the bar steps down 25 -> 15 -> 10 -> 5 until it
// fills 10. The v4 SQL already pulls thin evidence toward 0, so low-volume names no longer spike to +80%.
const LIST_VOLUME = (process.env.MOVERS_LIST_VOLUME || '25,15,10,5').split(',').map(Number).filter(n => n > 0);
const TOP = 10;

// Speed: the heavy work (Metabase over 100k+ cards, public data, picture lookups) never runs while
// someone waits. It runs on a schedule (vercel.json "crons") and the result is saved to Postgres.
// Page loads just read that saved snapshot, which takes tens of milliseconds.
const SNAP = 'sys:movers:snapshot';
export const INDEX = 'sys:movers:index';     // every qualifying name, for look-ups
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
    card_image: typeof (r.card_image || r.image) === 'string' && /^https:\/\//.test(r.card_image || r.image) ? (r.card_image || r.image) : '',
    card_title: String(r.card_title || '').slice(0, 160),
    raw_market: String(r.raw_market || '').slice(0, 200),
    raw_url: typeof r.raw_url === 'string' && /^https:\/\//.test(r.raw_url) ? r.raw_url : '',
    change30: Number(r.change30),
    volume30: Math.round(Number(r.volume30) || 0),
    spark: spark.length > 120 ? spark.slice(-120) : spark,
  };
}

async function fromFeed() {
  // Uses the Metabase host + API key already set in Vercel (METABASE_HOST / METABASE_API_KEY, the
  // same names other Arena tools use). MOVERS_SOURCE_URL / MOVERS_METABASE_API_KEY override them.
  const key = process.env.MOVERS_METABASE_API_KEY || process.env.METABASE_API_KEY || process.env.METABASE_KEY || '';
  let host = (process.env.METABASE_HOST || process.env.METABASE_URL || process.env.METABASE_SITE_URL ||
              'https://arena-club.metabaseapp.com').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (!/^https?:\/\//.test(host)) host = 'https://' + host;
  const question = process.env.MOVERS_QUESTION_ID || '43429';
  const src = process.env.MOVERS_SOURCE_URL || host + '/api/card/' + question + '/query/json';
  const isMb = /\/api\/card\/\d+\/query\/json/.test(src);
  if (isMb && !key) throw new Error('no Metabase API key found (METABASE_API_KEY) in Vercel');
  const headers = { accept: 'application/json' };
  if (process.env.MOVERS_SOURCE_TOKEN) headers.authorization = 'Bearer ' + process.env.MOVERS_SOURCE_TOKEN;
  // Metabase saved question: POST <metabase>/api/card/<id>/query/json with an API key (stays private,
  // no public link needed). Anything else is fetched with GET.
  const isMetabase = isMb;
  if (key) headers['x-api-key'] = key;
  const r = await fetch(src, isMetabase ? { method: 'POST', headers } : { headers });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 160); } catch (e) { /* none */ }
    throw new Error('Metabase returned ' + r.status +
      (r.status === 401 || r.status === 403 ? ' (check the API key and that its group can run question ' + (process.env.MOVERS_QUESTION_ID || '43429') + ')' : '') +
      (detail ? ': ' + detail : ''));
  }
  const d = await r.json();
  if (d && !Array.isArray(d) && (d.error || d.message)) throw new Error('Metabase: ' + String(d.error || d.message).slice(0, 200));
  const rows = (Array.isArray(d) ? d : (d.rows || d.data || [])).map(lowerKeys);
  if (!rows.length) throw new Error('Metabase question returned no rows');
  return rows;
}

// Where each category's numbers come from, shown under the lists.
const PUBLIC_NOTE = {
  pokemon_tcg: 'Raw (ungraded) Pokémon market: Cardmarket average sold prices and TCGplayer market prices via the Pokémon TCG API. Count = cards with sales in the last 30 days.',
};
const NO_DATA = 'Not enough sales yet: needs at least 3 PSA / Beckett / SGC / CSG sales in each of the last two 30-day windows.';

// "Shaquille O'Neal" / "Shaquille O'neal" / "SHAQUILLE O’NEAL", "LeBron James" / "Lebron James",
// "Bronny James Jr." / "Bronny James": one row each, sales-weighted.
function nameKey(n) {
  return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[.'\u2018\u2019\u02BC`\u00B4]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function mergeNames(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = String(r.category || '').toLowerCase() + '|' + nameKey(r.name);
    const v = Number(r.volume30) || 0, c = Number(r.change30);
    const g = by.get(k);
    if (!g) { by.set(k, { ...r, _w: v, _sum: Number.isFinite(c) ? c * Math.max(v, 1) : 0, _n: Math.max(v, 1) }); continue; }
    if (Number.isFinite(c)) { g._sum += c * Math.max(v, 1); g._n += Math.max(v, 1); }
    if (v > g._w) {                                  // the busiest spelling supplies name, photo and card
      Object.assign(g, { name: r.name, image: r.image || g.image, card_image: r.card_image || g.card_image,
        card_title: r.card_title || g.card_title, url: r.url || g.url, spark: r.spark || g.spark });
      g._w = v;
    }
    g.volume30 = (Number(g.volume30) || 0) + (g === r ? 0 : v);
  }
  return [...by.values()].map(g => { const o = { ...g, change30: +(g._sum / g._n).toFixed(2) };
    delete o._w; delete o._sum; delete o._n; return o; });
}

async function build() {
  let rows = [], notes = {}, errors = [], feedError = '';
  try { rows = await fromFeed(); } catch (e) { feedError = String(e.message || e); errors.push('Arena data: ' + feedError); }
  let sqlWarning = '';
  if (rows.length && !rows.some(r => String(r.method || '').startsWith('like-for-like-v4'))) {
    sqlWarning = 'Metabase question ' + (process.env.MOVERS_QUESTION_ID || '43429') + ' is still running the OLD SQL, ' +
      'which shows 0% for busy players. Paste the latest sql/movers.sql into it, save, then press Refresh.';
  }
  // multi-player cards ("LeBron James/Kobe Bryant") aren't one player, even if an older query sends them
  rows = mergeNames(rows.filter(r => !String(r.name || '').includes('/')));
  const fed = new Set(rows.map(x => catOf(x.category)));

  // Raw Pokémon TCG prices (TCGplayer / Cardmarket) are attached to our graded Pokémon rows for
  // the pop-up. Only if Metabase sent no Pokémon at all does the raw market fill the Pokémon list.
  let raw = new Map();
  if (process.env.MOVERS_PUBLIC !== 'off') {
    try {
      const pub = await pokemonRows();
      for (const r of pub) raw.set(character(r.name).toLowerCase(), r);
      if (!fed.has('pokemon')) {
        rows = rows.concat(pub.map(r => { const o = { ...r, category: 'pokemon' }; delete o.variants; return o; }));
        notes.pokemon = PUBLIC_NOTE.pokemon_tcg;
      }
    } catch (e) { errors.push('Pokémon TCG prices: ' + (e.message || e)); }
  }
  for (const r of rows) {
    if (catOf(r.category) !== 'pokemon') continue;
    const m = raw.get(character(r.name).toLowerCase());
    if (!m) continue;
    const same = (m.variants || []).find(v => v.name.toLowerCase() === String(r.name).toLowerCase());
    const pick = same || m;                          // exact printing if we have it, else the character's top card
    r.raw_market = pick.raw_market; r.raw_url = pick.raw_url;
  }

  const index = [];
  const categories = CATS.map(c => {
    const pool = rows.filter(x => catOf(x.category) === c.id).map(clean)
      .filter(x => x.name && Number.isFinite(x.change30) &&
        x.volume30 >= (notes[c.id] ? 3 : MIN_VOLUME));        // public Pokémon: 3+ cards per character
    for (const x of pool) index.push({ category: c.id, name: x.name, change30: x.change30, volume30: x.volume30,
      spark: x.spark.length > 20 ? x.spark.slice(-20) : x.spark, url: x.url, card_image: x.card_image, card_title: x.card_title,
      raw_market: x.raw_market, raw_url: x.raw_url });
    // public Pokémon counts cards, not sales, so it keeps its own small bar
    const bars = notes[c.id] ? [3] : LIST_VOLUME;
    // each side steps its bar down on its own, only as far as it needs to fill 10
    const pick = (sign) => {
      let best = [], used = bars[0];
      for (const bar of bars) {
        best = pool.filter(x => x.volume30 >= bar && Math.sign(x.change30) === sign)
          .sort((a, b) => sign * (b.change30 - a.change30) || b.volume30 - a.volume30).slice(0, TOP);
        used = bar;
        if (best.length >= TOP) break;
      }
      return { list: best, bar: used };
    };
    const R = pick(1), F = pick(-1);
    const up = R.list, down = F.list, listBar = Math.max(R.bar, F.bar);
    return { id: c.id, label: c.label, kind: c.kind, risers: up, fallers: down, listBar,
      volLabel: notes[c.id] ? 'cards' : 'sales',
      note: notes[c.id] || (pool.length ? '' : feedError ? 'Arena data feed not connected: ' + feedError : NO_DATA) };
  });
  if (!categories.some(c => c.risers.length || c.fallers.length))
    return { ok: false, why: errors.length ? errors.join(' · ') : 'no-source' };
  await Promise.all(categories.map(c => addImages([...c.risers, ...c.fallers], c.id)));
  return { ok: true, asOf: new Date().toISOString(), minVolume: MIN_VOLUME, categories, feedError, sqlWarning, cfg: config(),
    _index: index };
}

function config() {
  return [process.env.MOVERS_SOURCE_URL || process.env.METABASE_HOST || process.env.METABASE_URL || '43429',
    !!(process.env.MOVERS_METABASE_API_KEY || process.env.METABASE_API_KEY || process.env.METABASE_KEY),
    process.env.MOVERS_MIN_VOLUME || '', process.env.MOVERS_LIST_VOLUME || '', process.env.MOVERS_PUBLIC || '', 'v15'].join('|');
}
export async function rebuild() {
  const body = await build();
  body.builtAt = new Date().toISOString();
  const index = body._index || []; delete body._index;
  if (body.ok) {                                          // a failed build never replaces good data
    await kvSet(SNAP, JSON.stringify(body));
    await kvSet(INDEX, JSON.stringify({ builtAt: body.builtAt, rows: index, labels: Object.fromEntries(
      body.categories.map(c => [c.id, { label: c.label, volLabel: c.volLabel }])) }));
  }
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
      // first time, settings changed since it was built (say, the API key was just added),
      // or the Arena feed failed last time and it's been over 15 minutes: rebuild now
      const stale = body && (body.cfg !== config() ||
        (body.feedError && Date.now() - Date.parse(body.builtAt || 0) > 15 * 60000));
      if (!body || stale) {
        const fresh = await rebuild();
        body = fresh.ok ? fresh : (body || fresh);
      }
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).json(body);
  } catch (e) {
    res.status(200).json({ ok: false, why: String(e && e.message || e) });
  }
});
