import { requireUser } from '../lib/auth.js';
import { kvGet, kvSet, kvDel, scope } from '../lib/db.js';

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

export default requireUser(async function (req, res, who) {
  const key = (req.query.key || (req.body && req.body.key) || '').toString();
  if (!key) { res.status(400).json({ error: 'key is required' }); return; }
  const k = scope(key, who.email);
  try {
    if (req.method === 'GET') {
      res.status(200).json({ value: await kvGet(k) });
    } else if (req.method === 'POST' || req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      await kvSet(k, String(body.value == null ? '' : body.value));
      res.status(200).json({ ok: true });
    } else if (req.method === 'DELETE') {
      await kvDel(k);
      res.status(200).json({ ok: true });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});
