import { readSession } from '../lib/auth.js';
import { roster } from '../lib/db.js';

export default async function handler(req, res) {
  try {
    const who = await readSession(req);
    if (!who) { res.status(200).json({ ok: false, why: 'not-signed-in' }); return; }
    const users = await roster();
    const me = users.find(u => u.id === who.email);
    if (!me) { res.status(200).json({ ok: false, why: 'not-signed-in' }); return; }
    res.status(200).json({ ok: true, me, users });
  } catch (e) {
    res.status(500).json({ ok: false, why: 'database: ' + (e && e.message) });
  }
}
