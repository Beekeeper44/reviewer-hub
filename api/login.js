export default function handler(req, res) {
  const base = 'https://' + req.headers.host;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: base + '/api/callback',
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    access_type: 'online'
  });
  const hd = (process.env.ALLOWED_DOMAIN || '').trim();
  if (hd) params.set('hd', hd);   // a hint, not a guarantee; the callback enforces it
  res.redirect(302, 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
}
