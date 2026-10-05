import { requireUser, niceName } from '../lib/auth.js';
import { roster, addUser, setUserRole } from '../lib/db.js';

const ROLES = ['reviewer', 'expert', 'admin'];

async function amAdmin(email) {
  const all = await roster();
  const me = all.find(function (u) { return u.id === email; });
  return !!me && me.role === 'admin';
}

export default requireUser(async function (req, res, who) {
  try {
    if (req.method === 'GET') { res.status(200).json({ users: await roster() }); return; }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!(await amAdmin(who.email))) {
      res.status(403).json({ error: 'Only an admin can do that.' }); return;
    }

    if (body.action === 'add') {
      const mail = String(body.email || '').trim().toLowerCase();
      if (mail.indexOf('@') < 1 || mail.indexOf('.') < 0) {
        res.status(400).json({ error: 'That is not an email address.' }); return;
      }
      const all = await roster();
      if (all.some(function (u) { return u.id === mail; })) {
        res.status(400).json({ error: 'They are already on the list.' }); return;
      }
      await addUser(mail, niceName(mail), 'reviewer');
      res.status(200).json({ users: await roster() });
      return;
    }

    if (body.action === 'role') {
      const mail = String(body.email || '').toLowerCase();
      const role = String(body.role || '');
      if (ROLES.indexOf(role) < 0) { res.status(400).json({ error: 'Unknown role.' }); return; }
      const all = await roster();
      const admins = all.filter(function (u) { return u.role === 'admin'; });
      if (admins.length === 1 && admins[0].id === mail && role !== 'admin') {
        res.status(400).json({ error: 'Someone has to stay an admin.' }); return;
      }
      await setUserRole(mail, role);
      res.status(200).json({ users: await roster() });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});
