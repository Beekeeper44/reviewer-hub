import { requireUser } from '../lib/auth.js';

// ESPN's public scoreboard feeds. A league shows up on the ticker only when ESPN
// reports it in an active season (pre, regular or post) and has games on its board.
const LEAGUES = [
  { id: 'nfl',   label: 'NFL',   path: 'football/nfl' },
  { id: 'ncaaf', label: 'NCAAF', path: 'football/college-football' },
  { id: 'mlb',   label: 'MLB',   path: 'baseball/mlb' },
  { id: 'nba',   label: 'NBA',   path: 'basketball/nba' },
  { id: 'wnba',  label: 'WNBA',  path: 'basketball/wnba' },
  { id: 'nhl',   label: 'NHL',   path: 'hockey/nhl' },
  { id: 'ncaam', label: 'NCAAM', path: 'basketball/mens-college-basketball' },
  { id: 'mls',   label: 'MLS',   path: 'soccer/usa.1' },
  { id: 'epl',   label: 'EPL',   path: 'soccer/eng.1' },
];

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
const MAX_PER_LEAGUE = 16;
const FINAL_KEEP_MS = 36 * 3600 * 1000;   // drop finals older than a day and a half
const ORDER = { in: 0, pre: 1, post: 2 };

async function fetchLeague(l) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(BASE + l.path + '/scoreboard', {
      signal: ctl.signal, headers: { accept: 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const lg = (d.leagues && d.leagues[0]) || {};
    const seasonType = lg.season && lg.season.type && lg.season.type.type;
    if (seasonType === 4) return null;                        // off season
    const logos = lg.logos || [];
    const dark = logos.find(x => (x.rel || []).includes('dark')) || logos[0];
    const now = Date.now();

    const games = (d.events || []).map(ev => {
      const c = (ev.competitions || [])[0] || {};
      const st = (c.status || ev.status || {}).type || {};
      const side = ha => {
        const x = (c.competitors || []).find(k => k.homeAway === ha) || {};
        const tm = x.team || {};
        return {
          abbr: tm.abbreviation || tm.shortDisplayName || '?',
          name: tm.shortDisplayName || tm.displayName || '',
          logo: tm.logo || '',
          color: tm.color ? '#' + tm.color : '',
          score: x.score != null && x.score !== '' ? String(x.score) : '',
          winner: !!x.winner,
        };
      };
      const link = (ev.links || []).find(k => (k.rel || []).includes('summary'));
      return {
        id: ev.id,
        date: ev.date,
        state: st.state || 'pre',                 // pre | in | post
        detail: st.shortDetail || st.detail || '',
        away: side('away'),
        home: side('home'),
        url: link ? link.href : '',
      };
    })
    .filter(g => g.state !== 'post' || now - Date.parse(g.date) < FINAL_KEEP_MS)
    .filter(g => g.state !== 'pre' || !/postponed|canceled|cancelled/i.test(g.detail))
    .sort((a, b) => (ORDER[a.state] - ORDER[b.state]) ||
      (a.state === 'post' ? Date.parse(b.date) - Date.parse(a.date)
                          : Date.parse(a.date) - Date.parse(b.date)))
    .slice(0, MAX_PER_LEAGUE);

    if (!games.length) return null;
    return { id: l.id, label: l.label, logo: dark ? dark.href : '', games };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export default requireUser(async function (req, res) {
  const out = (await Promise.all(LEAGUES.map(fetchLeague))).filter(Boolean);
  // live leagues first
  out.sort((a, b) =>
    (b.games.some(g => g.state === 'in') - a.games.some(g => g.state === 'in')));
  const live = out.some(l => l.games.some(g => g.state === 'in'));
  // Vercel's edge cache absorbs the team's polling, so ESPN sees one request per window
  res.setHeader('Cache-Control',
    live ? 's-maxage=20, stale-while-revalidate=40' : 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({ ok: true, live, at: new Date().toISOString(), leagues: out });
});
