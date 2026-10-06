import { requireUser, niceName, newToken, tokenHash } from '../lib/auth.js';
import { roster, addUser, setUserRole, removeUser, saveInvite } from '../lib/db.js';

const ROLES = ['reviewer', 'expert', 'admin'];
const INVITE_DAYS = 7;

async function amAdmin(email) {
  const me = (await roster()).find(u => u.id === email);
  return !!me && me.role === 'admin';
}
async function inviteLink(req, email) {
  const t = newToken();
  await saveInvite(tokenHash(t), email, INVITE_DAYS);
  return 'https://' + req.headers.host + '/api/invite?t=' + t;
}

export default requireUser(async function (req, res, who) {
  try {
    if (req.method === 'GET') { res.status(200).json({ users: await roster() }); return; }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!(await amAdmin(who.email))) { res.status(403).json({ error: 'Only an admin can do that.' }); return; }
    const all = await roster();
    const mail = String(body.email || '').trim().toLowerCase();

    if (body.action === 'add') {
      if (mail.indexOf('@') < 1 || mail.indexOf('.') < 0) { res.status(400).json({ error: 'That is not an email address.' }); return; }
      if (all.some(u => u.id === mail)) { res.status(400).json({ error: 'They are already on the team. Use New link to resend.' }); return; }
      const role = ROLES.includes(body.role) ? body.role : 'reviewer';
      await addUser(mail, String(body.name || '').trim() || niceName(mail), role);
      res.status(200).json({ users: await roster(), link: await inviteLink(req, mail), email: mail, days: INVITE_DAYS });
      return;
    }

    if (body.action === 'link') {       // resend, or reset a forgotten password
      if (!all.some(u => u.id === mail)) { res.status(404).json({ error: 'Not on the team.' }); return; }
      res.status(200).json({ users: all, link: await inviteLink(req, mail), email: mail, days: INVITE_DAYS });
      return;
    }

    const admins = all.filter(u => u.role === 'admin');

    if (body.action === 'role') {
      const role = String(body.role || '');
      if (!ROLES.includes(role)) { res.status(400).json({ error: 'Unknown role.' }); return; }
      if (admins.length === 1 && admins[0].id === mail && role !== 'admin') { res.status(400).json({ error: 'Someone has to stay an admin.' }); return; }
      await setUserRole(mail, role);
      res.status(200).json({ users: await roster() });
      return;
    }

    if (body.action === 'remove') {
      if (mail === who.email) { res.status(400).json({ error: "You can't remove yourself." }); return; }
      if (admins.length === 1 && admins[0].id === mail) { res.status(400).json({ error: 'Someone has to stay an admin.' }); return; }
      await removeUser(mail);          // their session stops working within 30 seconds
      res.status(200).json({ users: await roster() });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});
