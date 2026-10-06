import { rebuild } from './movers.js';

// Called by Vercel Cron (see vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>".
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) {
    res.status(401).json({ ok: false, why: 'Set CRON_SECRET in Vercel; only the scheduler may call this.' });
    return;
  }
  const t = Date.now();
  try {
    const b = await rebuild();
    res.status(200).json({ ok: b.ok, why: b.why || '', ms: Date.now() - t,
      categories: (b.categories || []).map(c => c.id + ':' + c.risers.length + '/' + c.fallers.length) });
  } catch (e) {
    res.status(500).json({ ok: false, why: String(e && e.message || e) });
  }
}
