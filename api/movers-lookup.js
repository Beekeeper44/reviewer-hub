import { requireUser, readBody } from '../lib/auth.js';
import { kvGet } from '../lib/db.js';
import { imageFor } from '../lib/images.js';
import { INDEX } from './movers.js';

// Find players / characters by name in Arena Club's own numbers.
// Takes typed names, or the raw text read off a screenshot (OCR runs in the browser), and
// matches it against every name in the latest Risers & Fallers build, tolerating OCR typos.

let memo = null;                                    // { at, data, prepared }
async function index() {
  if (memo && Date.now() - memo.at < 5 * 60000) return memo;
  const raw = await kvGet(INDEX);
  const data = raw ? JSON.parse(raw) : { rows: [], labels: {} };
  data.rows = data.rows.filter(r => !String(r.name || '').includes('/'));
  const prepared = data.rows.map(r => ({ r, toks: norm(r.name).split(' ').filter(Boolean) })).filter(p => p.toks.length);
  memo = { at: Date.now(), data, prepared };
  return memo;
}

export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[|]/g, 'l').replace(/['\u2018\u2019\u02BC`\u00B4]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function lev(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// a token from the name matches a token from the text if it's the same, or 1 typo off for 5+ letters
const tokOk = (n, t) => n === t || (n.length >= 5 && lev(n, t) <= 1) || (n.length >= 9 && lev(n, t) <= 2);

// Look for the name's tokens as a consecutive run in one line of text.
function scoreLine(toks, lineToks) {
  const k = toks.length;
  if (k === 1) {                                    // single-word names (Imu, Kuro, Pikachu) must be whole words
    return lineToks.some(t => t === toks[0] || (toks[0].length >= 6 && lev(t, toks[0]) <= 1)) ? 1 : 0;
  }
  for (let i = 0; i + k <= lineToks.length; i++) {
    let ok = true;
    for (let j = 0; j < k && ok; j++) ok = tokOk(toks[j], lineToks[i + j]);
    if (ok) return k;
  }
  // also allow the name split across a line with "Monkey.D.Luffy" style dots already turned to spaces
  return 0;
}

export default requireUser(async function (req, res) {
  try {
    const b = req.method === 'POST' ? readBody(req) : req.query;
    const text = String(b.text || '').slice(0, 20000);
    let cat = String(b.category || '');
    const typed = !(b.image === true || b.image === 'true');
    const exact = b.exact === true || b.exact === 'true';      // the saved list: whole names only
    const { data, prepared } = await index();
    if (!data.rows.length) { res.status(200).json({ ok: false, why: 'No Risers & Fallers build yet. Open the page and press Refresh first.' }); return; }

    const rawLines = text.split(/\n+/).map(x => x.trim()).filter(x => norm(x));
    const lines = rawLines.map(norm);
    const lineToks = lines.map(l => l.split(' '));
    const want = exact ? new Set(lines) : null;
    const run = (onlyCat) => {
      const seen = new Map();
      for (const p of prepared) {
        if (onlyCat && onlyCat !== 'all' && p.r.category !== onlyCat) continue;
        if (want) {
          const k = p.toks.join(' ');
          if (!want.has(k)) continue;
          const key = p.r.category + '|' + p.r.name;
          if (!seen.has(key)) seen.set(key, { ...p.r, _line: lines.indexOf(k), _len: p.toks.length, _partial: false });
          continue;
        }
        let best = 0, at = -1;
        for (let i = 0; i < lineToks.length; i++) {
          let sc = scoreLine(p.toks, lineToks[i]);
          // typed names can be partial: "Charizard" finds "Charizard ex", "Charizard VMAX", "Mega Charizard"
          if (!sc && typed && lineToks[i].every(t => t.length >= 3)) sc = scoreLine(lineToks[i], p.toks) ? 0.5 : 0;
          if (sc > best) { best = sc; at = i; }
        }
        if (!best) continue;
        const key = p.r.category + '|' + p.r.name;
        if (!seen.has(key)) seen.set(key, { ...p.r, _line: at, _len: p.toks.length, _partial: best === 0.5 });
      }
      return seen;
    };
    let seen = run(cat), widened = false;
    if (!seen.size && cat && cat !== 'all') { seen = run('all'); widened = seen.size > 0; }
    // if "Luffy" and "Monkey D Luffy" both matched the same line, keep the longer name
    let hits = [...seen.values()];
    hits = hits.filter(h => h._partial || !hits.some(o => o !== h && !o._partial && o._line === h._line && o._len > h._len &&
      norm(o.name).includes(norm(h.name))));
    { const m = new Map();
      for (const h of hits) { const k = h.category + '|' + norm(h.name); const g = m.get(k);
        if (!g) m.set(k, h);
        else { const v = g.volume30 + h.volume30;
          g.change30 = +((g.change30 * g.volume30 + h.change30 * h.volume30) / Math.max(v, 1)).toFixed(2);
          if (h.volume30 > g.volume30) Object.assign(g, { name: h.name, spark: h.spark, url: h.url, card_image: h.card_image, card_title: h.card_title });
          g.volume30 = v; } }
      hits = [...m.values()]; }
    hits.sort((a, b) => a._line - b._line || b.volume30 - a.volume30);
    hits = hits.slice(0, exact ? 500 : 40);

    // which typed lines found nothing (only meaningful for typed names, not OCR noise)
    const missed = lines.length <= 25 ? rawLines.filter((l, i) => !hits.some(h => h._line === i)) : [];

    // pictures: cached lookups, a few seconds at most
    const stop = Date.now() + (exact ? 9000 : 6000);
    for (let i = 0; i < hits.length && Date.now() < stop; i += 5)
      await Promise.all(hits.slice(i, i + 5).map(async h => {
        h.image = (await imageFor(h.name, h.category).catch(() => '')) || h.card_image || '';
      }));
    const typedKeys = new Set(lines);
    for (const h of hits) { h.exact = typedKeys.has(norm(h.name)); delete h._line; delete h._len; delete h._partial; }
    hits.sort((a, b) => (b.exact - a.exact));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, builtAt: data.builtAt, labels: data.labels, hits, missed, widened });
  } catch (e) {
    res.status(200).json({ ok: false, why: String(e && e.message || e) });
  }
});
