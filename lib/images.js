import { kvGet, kvSet } from './db.js';

// Finds a picture for a player or character, server side, and remembers it.
//
//   Sports players:  ESPN headshot  ->  Wikipedia page image
//   Pokémon:         TCGplayer (if keys are set)  ->  Pokémon TCG API  ->  Wikipedia
//   One Piece:       TCGplayer (if keys are set)  ->  Wikipedia
//
// Results, including misses, are cached in the kv table for 30 days, so each name is looked up
// once a month rather than on every page load.

const UA = 'ArenaClub-ReviewHub/1.5 (internal tool)';
const TTL = 30 * 24 * 3600 * 1000;
const MISS_TTL = 3 * 24 * 3600 * 1000;       // try again sooner if nothing was found
const mem = new Map();

async function getJSON(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': UA, ...(opts.headers || {}) } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}

/* ---------- ESPN: athlete search, take the first headshot on ESPN's image CDN ---------- */
const ESPN_LEAGUE = { baseball: 'mlb', basketball: 'nba', football: 'nfl' };
async function espn(name, cat) {
  const d = await getJSON('https://site.web.api.espn.com/apis/common/v3/search?limit=5&type=player&query=' +
    encodeURIComponent(name));
  if (!d) return '';
  // The response shape isn't documented, so walk it and take the first headshot URL, preferring
  // one from the right league.
  const found = [];
  (function walk(o) {
    if (!o || found.length > 20) return;
    if (typeof o === 'string') { if (/^https:\/\/a\.espncdn\.com\/.*headshots\//.test(o)) found.push(o); return; }
    if (typeof o === 'object') for (const k in o) walk(o[k]);
  })(d);
  const lg = ESPN_LEAGUE[cat];
  return found.find(u => lg && u.includes('/' + lg + '/')) || found[0] || '';
}

/* ---------- Wikipedia: search with a sport hint, take the page's lead image ---------- */
const WIKI_HINT = {
  baseball: 'baseball player', basketball: 'basketball player', football: 'American football player',
  pokemon: 'Pokémon', onepiece: 'One Piece character',
};
async function wikipedia(name, cat) {
  const q = name + ' ' + (WIKI_HINT[cat] || '');
  const d = await getJSON('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
    '&generator=search&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=240&gsrsearch=' + encodeURIComponent(q));
  const p = d && d.query && d.query.pages && d.query.pages[0];
  return (p && p.thumbnail && p.thumbnail.source) || '';
}

/* ---------- TCGplayer official API (needs a developer key pair) ---------- */
// Category ids: Pokémon = 3. One Piece Card Game defaults to 68; override with TCGPLAYER_ONEPIECE_CATEGORY.
const TCG_CAT = { pokemon: 3, onepiece: Number(process.env.TCGPLAYER_ONEPIECE_CATEGORY || 68) };
let tcgToken = null;                              // { value, exp }
async function tcgAuth() {
  if (tcgToken && tcgToken.exp > Date.now() + 60000) return tcgToken.value;
  const id = process.env.TCGPLAYER_PUBLIC_KEY, secret = process.env.TCGPLAYER_PRIVATE_KEY;
  if (!id || !secret) return null;
  const d = await getJSON('https://api.tcgplayer.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(id) +
          '&client_secret=' + encodeURIComponent(secret),
  });
  if (!d || !d.access_token) return null;
  tcgToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return tcgToken.value;
}
async function tcgplayer(name, cat) {
  if (!TCG_CAT[cat]) return '';
  const tok = await tcgAuth();
  if (!tok) return '';
  const d = await getJSON('https://api.tcgplayer.com/catalog/products?limit=1&categoryId=' + TCG_CAT[cat] +
    '&productName=' + encodeURIComponent(name), { headers: { authorization: 'bearer ' + tok } });
  const p = d && d.results && d.results[0];
  return (p && p.imageUrl) || '';
}

/* ---------- Pokémon TCG API (free; a key only raises the rate limit) ---------- */
async function pokemontcg(name) {
  const headers = process.env.POKEMONTCG_API_KEY ? { 'x-api-key': process.env.POKEMONTCG_API_KEY } : {};
  const base = name.replace(/\s+(ex|gx|v|vmax|vstar)$/i, '').replace(/"/g, '');
  for (const q of ['name:"' + name.replace(/"/g, '') + '"', 'name:"' + base + '*"']) {
    const d = await getJSON('https://api.pokemontcg.io/v2/cards?pageSize=1&orderBy=-set.releaseDate&select=images&q=' +
      encodeURIComponent(q), { headers });
    const c = d && d.data && d.data[0];
    if (c && c.images) return c.images.small || c.images.large || '';
  }
  return '';
}

const CHAIN = {
  baseball:   [espn, wikipedia],
  basketball: [espn, wikipedia],
  football:   [espn, wikipedia],
  pokemon:    [tcgplayer, (n) => pokemontcg(n), wikipedia],
  onepiece:   [tcgplayer, wikipedia],
};

export async function imageFor(name, cat) {
  const key = 'sys:img:' + cat + ':' + name.toLowerCase();
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;
  try {
    const raw = await kvGet(key);
    if (raw) {
      const c = JSON.parse(raw);
      if (c.exp > Date.now()) { mem.set(key, c); return c.url; }
    }
  } catch (e) { /* no database: still works, just uncached */ }
  let url = '';
  for (const f of CHAIN[cat] || [wikipedia]) {
    url = await f(name, cat).catch(() => '');
    if (url && /^https:\/\//.test(url)) break;
    url = '';
  }
  const c = { url, exp: Date.now() + (url ? TTL : MISS_TTL) };
  mem.set(key, c);
  kvSet(key, JSON.stringify(c)).catch(() => {});
  return url;
}

// Give every row an ESPN / Wikipedia / TCG picture, a few lookups at a time, within a time budget.
// A picture that came in with the feed (an Arena card photo) is kept only as the fallback.
export async function addImages(rows, cat, budgetMs = 6000) {
  const todo = rows;
  const stop = Date.now() + budgetMs;
  for (let i = 0; i < todo.length && Date.now() < stop; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async r => { const u = await imageFor(r.name, cat); if (u) r.image = u; }));
  }
  return rows;
}
