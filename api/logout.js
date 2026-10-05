import { clearSession } from '../lib/auth.js';
export default function handler(req, res) {
  clearSession(res);
  res.redirect(302, '/');
}
