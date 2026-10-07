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

/* ---------- name matching, so a picture is only used if it's the right person ---------- */
function norm(n) {
  return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[.'’]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function sameName(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' '), ys = y.split(' ');
  // same last name and same first initial (Mike / Michael), or one name contains the other
  return (xs[xs.length - 1] === ys[ys.length - 1] && xs[0][0] === ys[0][0]) || x.includes(y) || y.includes(x);
}

/* ---------- ESPN: athlete search; keep only a headshot from the right sport and the right name ---------- */
const ESPN_LEAGUES = {
  baseball:   ['/mlb/', '/college-baseball/'],
  basketball: ['/nba/', '/wnba/', '/mens-college-basketball/', '/womens-college-basketball/'],
  football:   ['/nfl/', '/college-football/'],
};
async function espn(name, cat) {
  const lgs = ESPN_LEAGUES[cat];
  if (!lgs) return '';
  const d = await getJSON('https://site.web.api.espn.com/apis/common/v3/search?limit=10&type=player&query=' +
    encodeURIComponent(name));
  if (!d) return '';
  // The response shape isn't documented, so walk it, pairing each headshot URL with the nearest
  // athlete name above it.
  const hits = [];
  (function walk(o, who) {
    if (!o || hits.length > 40) return;
    if (typeof o === 'string') {
      if (/^https:\/\/a\.espncdn\.com\/.*headshots\//.test(o)) hits.push({ url: o, who });
      return;
    }
    if (typeof o !== 'object') return;
    const here = o.displayName || o.fullName || o.name || who;
    for (const k in o) walk(o[k], typeof here === 'string' ? here : who);
  })(d, '');
  const ok = hits.find(h => lgs.some(l => h.url.includes(l)) && sameName(h.who, name));
  return ok ? ok.url : '';
}

/* ---------- Wikipedia: exact page first, then a sport-hinted search; title must match ---------- */
const WIKI_HINT = {
  baseball: 'baseball player', basketball: 'basketball player', football: 'American football player',
  pokemon: 'Pokémon', onepiece: 'One Piece character',
};
const WIKI_TITLE = {
  baseball: ['(baseball)', '(baseball player)'], basketball: ['(basketball)', '(basketball player)'],
  football: ['(American football)', '(American football player)', '(football)'],
  pokemon: ['(Pokémon)'], onepiece: ['(One Piece)'],
};
const WIKI_DESC = { baseball: /baseball/i, basketball: /basketball/i, football: /football/i,
  pokemon: /pok[eé]mon/i, onepiece: /one piece/i };
async function wikiSummary(title, cat) {
  const d = await getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
  if (!d || d.type === 'disambiguation' || !d.thumbnail) return '';
  // the page has to be about the right thing: "American basketball player", not a namesake
  const about = (d.description || '') + ' ' + (d.extract || '').slice(0, 300);
  if (WIKI_DESC[cat] && !WIKI_DESC[cat].test(about)) return '';
  return d.thumbnail.source || '';
}
async function wikipedia(name, cat) {
  // 1. "Jerry Sichting (basketball)" style pages, then the plain name
  for (const suffix of (WIKI_TITLE[cat] || [])) {
    const u = await wikiSummary(name + ' ' + suffix, cat); if (u) return u;
  }
  if (cat !== 'pokemon' && cat !== 'onepiece') { const u = await wikiSummary(name, cat); if (u) return u; }
  // 2. search with a sport hint, and only accept a page titled with that name
  const q = name + ' ' + (WIKI_HINT[cat] || '');
  const d = await getJSON('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
    '&generator=search&gsrlimit=5&prop=pageimages&piprop=thumbnail&pithumbsize=240&gsrsearch=' + encodeURIComponent(q));
  const pages = (d && d.query && d.query.pages) || [];
  const p = pages.sort((a, b) => (a.index || 0) - (b.index || 0))
    .find(x => x.thumbnail && sameName(String(x.title).replace(/\s*\(.*\)$/, ''), name));
  return (p && p.thumbnail.source) || '';
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
  pokemon_tcg: [(n) => pokemontcg(n)],
};

export async function imageFor(name, cat) {
  const key = 'sys:img2:' + cat + ':' + name.toLowerCase();
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
export async function addImages(rows, cat, budgetMs = 25000) {
  const todo = rows;
  const stop = Date.now() + budgetMs;
  for (let i = 0; i < todo.length && Date.now() < stop; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async r => {
      if (r.image && /pokemontcg\.io/.test(r.image)) return;      // already real card art
      const u = await imageFor(r.name, cat); if (u) r.image = u; }));
  }
  return rows;
}
