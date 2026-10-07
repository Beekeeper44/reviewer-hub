import { kvGet, kvSet } from './db.js';

// Free, public Pokémon market data.
//
// The Pokémon TCG API (pokemontcg.io) publishes Cardmarket's average SOLD prices for every card:
// last 1, 7 and 30 days. This rolls those up by character (every Charizard card, every Pikachu
// card, ...) and ranks characters by how their recent sales compare with the last 30 days.
//
//   change30  = median across that character's cards of (7-day avg sold / 30-day avg sold - 1)
//   volume30  = number of that character's cards with real sales in the last 30 days
//
// A snapshot is saved every day, so after 30 days the change becomes a true price-today vs
// price-30-days-ago figure, and the trend line fills out to 90 days.

const API = 'https://api.pokemontcg.io/v2/cards';
const RARITIES = [
  'Special Illustration Rare', 'Illustration Rare', 'Hyper Rare', 'Ultra Rare', 'Double Rare',
  'Secret Rare', 'Rare Secret', 'Rare Rainbow', 'Rare Ultra', 'Rare Holo VMAX', 'Rare Holo VSTAR',
  'Rare Holo V', 'Rare Holo GX', 'Rare Holo EX', 'Rare Shiny', 'Shiny Rare', 'Shiny Ultra Rare',
  'Rare Shining', 'Amazing Rare', 'Radiant Rare', 'Trainer Gallery Rare Holo', 'Rare Holo Star',
  'Rare Prime', 'LEGEND', 'ACE SPEC Rare', 'Rare Holo',
];
const MIN_PRICE = Number(process.env.POKEMON_MIN_PRICE || 3);   // ignore bulk under this (EUR)
const MAX_PAGES = 40;
const SNAP_KEY = 'sys:pkpublic:v6';
const HIST_KEY = 'sys:pkhist:v2';
const SNAP_TTL = 12 * 3600 * 1000;

function headers() {
  const h = { accept: 'application/json', 'user-agent': 'ArenaClub-ReviewHub/1.5' };
  if (process.env.POKEMONTCG_API_KEY) h['x-api-key'] = process.env.POKEMONTCG_API_KEY;
  return h;
}
async function page(n) {
  const q = '(' + RARITIES.map(r => 'rarity:"' + r + '"').join(' OR ') + ')';
  const url = API + '?pageSize=250&page=' + n + '&select=id,name,images,cardmarket,tcgplayer&q=' + encodeURIComponent(q);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { headers: headers(), signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
    } catch (e) { /* retry once */ }
  }
  return null;
}

// "Team Rocket's Mewtwo ex" -> "Mewtwo", "Radiant Charizard" -> "Charizard", "Pikachu VMAX" -> "Pikachu"
export function character(name) {
  let n = String(name || '').trim();
  const mega = /^(mega|m)\s/i.test(n);
  n = n.replace(/^(radiant|shining|dark|light|mega|m|primal|alolan|galarian|hisuian|paldean|ancient|future)\s+/i, '');
  n = n.replace(/^.+?['’]s\s+/, '');                                     // trainer's Pokémon
  n = n.replace(/\s*[-&]?\s*(ex|gx|v|vmax|vstar|v-union|break|lv\.?\s?x|prime|legend|star|δ|☆|tag team.*)$/i, '');
  n = n.replace(/\s*\(.*\)$/, '').replace(/\s+(ex|gx|v)$/i, '');
  n = n.replace(/[★☆δ◇♢]/g, '').replace(/\s+(star|gold star|prism star)$/i, '');
  // Platinum-era SP and other letter suffixes: Charizard G, Rayquaza C, Infernape E4, Garchomp GL, Lucario FB, Dialga LV.X
  n = n.replace(/\s+(g|gl|c|e4|fb|m|lv\.?\s?x|break|v-?union|sp)$/i, '');
  n = n.replace(/\s+(ex|gx|v|vmax|vstar)$/i, '').replace(/\s{2,}/g, ' ');
  if (mega) n = n.replace(/\s+[xy]$/i, '');                         // Mega Charizard X -> Charizard
  return n.trim();
}

async function loadCards() {
  const first = await page(1);
  if (!first || !Array.isArray(first.data)) throw new Error('Pokémon TCG API did not respond');
  const pages = Math.min(MAX_PAGES, Math.ceil((first.totalCount || first.data.length) / 250));
  let cards = first.data;
  for (let n = 2; n <= pages; n += 5) {
    const batch = await Promise.all([0, 1, 2, 3, 4].map(k => n + k <= pages ? page(n + k) : null));
    for (const b of batch) if (b && Array.isArray(b.data)) cards = cards.concat(b.data);
  }
  return cards;
}

function rawLine(x) {
  return 'Raw market (' + x.name + '): ' + (x.tcg ? 'TCGplayer $' + x.tcg.toFixed(2) + ' · ' : '') +
    'Cardmarket 30-day avg €' + x.a30.toFixed(2);
}
function median(a) {
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
}

async function history(today) {
  // { asOf, chars: { name: [[YYYY-MM-DD, price], ...] } } capped at 95 days
  let h = { chars: {} };
  try { const raw = await kvGet(HIST_KEY); if (raw) h = JSON.parse(raw); } catch (e) { /* fresh */ }
  const day = new Date().toISOString().slice(0, 10);
  for (const [name, price] of Object.entries(today)) {
    const arr = h.chars[name] || (h.chars[name] = []);
    if (!arr.length || arr[arr.length - 1][0] !== day) arr.push([day, +price.toFixed(2)]);
    else arr[arr.length - 1][1] = +price.toFixed(2);
    if (arr.length > 95) arr.splice(0, arr.length - 95);
  }
  h.asOf = day;
  kvSet(HIST_KEY, JSON.stringify(h)).catch(() => {});
  return h.chars;
}

export async function pokemonRows() {
  try {
    const raw = await kvGet(SNAP_KEY);
    if (raw) { const s = JSON.parse(raw); if (Date.now() - s.at < SNAP_TTL) return s.rows; }
  } catch (e) { /* rebuild */ }

  const cards = await loadCards();
  const by = new Map();
  for (const c of cards) {
    const p = c.cardmarket && c.cardmarket.prices;
    if (!p) continue;
    const a7 = Number(p.avg7), a30 = Number(p.avg30), a1 = Number(p.avg1);
    if (!(a30 >= MIN_PRICE) || !(a7 > 0)) continue;
    const who = character(c.name);
    if (!who) continue;
    const g = by.get(who) || { cards: [] };
    // TCGplayer market price (USD) for the card's main printing, when published
    const tp = c.tcgplayer && c.tcgplayer.prices ? c.tcgplayer.prices : {};
    const v = tp.holofoil || tp.normal || tp.reverseHolofoil || tp['1stEditionHolofoil'] || Object.values(tp)[0] || {};
    g.cards.push({ a1: a1 > 0 ? a1 : a7, a7, a30, name: c.name, big: c.images && (c.images.large || c.images.small),
      img: c.images && (c.images.small || c.images.large),
      tcg: Number(v.market) > 0 ? Number(v.market) : 0, tcgUrl: (c.tcgplayer && c.tcgplayer.url) || '',
      url: (c.tcgplayer && c.tcgplayer.url) || c.cardmarket.url || '' });
    by.set(who, g);
  }

  // today's price level per character = median 7-day average across its cards
  const level = {};
  for (const [who, g] of by) level[who] = median(g.cards.map(x => x.a7));
  const hist = await history(level);

  const rows = [];
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  for (const [who, g] of by) {
    const h = hist[who] || [];
    const old = h.find(([d]) => d <= cutoff && d >= new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10));
    let change30;
    if (old && old[1] > 0) change30 = (level[who] / old[1] - 1) * 100;          // true 30-day change
    else change30 = median(g.cards.map(x => x.a7 / x.a30 - 1)) * 100;          // until history builds up
    const top = g.cards.slice().sort((a, b) => b.a30 - a.a30)[0];
    const spark = h.length >= 5 ? h.map(x => x[1])
      : [median(g.cards.map(x => x.a30)), median(g.cards.map(x => x.a7)), median(g.cards.map(x => x.a1))];
    rows.push({ category: 'pokemon_tcg', name: who, image: top.img || '', url: top.url,
      card_image: top.big || top.img || '',
      card_title: top.name + ' · raw, ungraded · Cardmarket 30-day avg €' + top.a30.toFixed(2) +
        (top.tcg ? ' · TCGplayer market $' + top.tcg.toFixed(2) : ''),
      raw_market: rawLine(top), raw_url: top.tcgUrl || top.url,
      // every printing of this character, so a graded "Charizard ex" can find the raw Charizard ex
      variants: g.cards.slice().sort((a, b) => b.a30 - a.a30).slice(0, 25)
        .map(x => ({ name: x.name, raw_market: rawLine(x), raw_url: x.tcgUrl || x.url })),
      change30: +change30.toFixed(2), volume30: g.cards.length, spark });
  }
  kvSet(SNAP_KEY, JSON.stringify({ at: Date.now(), rows })).catch(() => {});
  return rows;
}
