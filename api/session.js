import { readSession, isBootAdmin } from '../lib/auth.js';
import { roster } from '../lib/db.js';

export default async function handler(req, res) {
  const who = readSession(req);
  if (!who) { res.status(200).json({ ok: false, why: 'not-signed-in' }); return; }
  try {
    const users = await roster();
    let me = users.find(function (u) { return u.id === who.email; });
    if (!me) me = { id: who.email, name: who.name || who.email, role: isBootAdmin(who.email) ? 'admin' : 'reviewer' };
    res.status(200).json({ ok: true, me: me, users: users.length ? users : [me] });
  } catch (e) {
    res.status(500).json({ ok: false, why: 'database: ' + (e && e.message) });
  }
}
