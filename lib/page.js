// Plain server-rendered pages for signing in and accepting an invite. Same look as the app.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

export function page(res, title, inner, status) {
  res.status(status || 200);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Review Hub</title>
<style>
:root{--g:#5DFF64;--ink:#F2F5F3;--bg:#0E1211;--box:#161C1A;--line:#2A3430}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
main{width:100%;max-width:400px;background:var(--box);border:1px solid var(--line);border-radius:16px;padding:30px 28px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.02em}
.sub{margin:0 0 22px;font-size:14px}
label{display:block;font-size:13px;font-weight:700;margin:14px 0 6px}
input{width:100%;padding:12px 13px;border-radius:10px;border:1.5px solid var(--line);background:#0B0F0E;
  color:var(--ink);font-size:16px}
input:focus{outline:none;border-color:var(--g)}
input[readonly]{opacity:.8}
button{width:100%;margin-top:22px;padding:13px;border:0;border-radius:999px;background:var(--g);color:#0E1211;
  font-size:16px;font-weight:800;cursor:pointer}
.err{background:#3A1414;border:1px solid #FF6B6B;color:#FFD7D7;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 6px}
.note{font-size:13px;margin:18px 0 0}
a{color:var(--g)}
.brand{font-weight:800;font-size:13px;letter-spacing:.08em;color:var(--g);margin:0 0 14px}
</style></head><body><main><p class="brand">REVIEW HUB</p>${inner}</main></body></html>`);
}
