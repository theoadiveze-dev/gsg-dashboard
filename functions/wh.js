const CACHE_S = 2592000;

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ error: 'missing q' }, 400);
  try {
    const res = await fetch('https://www.wowhead.com/items/name:' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      cf: { cacheTtl: CACHE_S, cacheEverything: true }
    });
    if (!res.ok) return json({ error: 'wowhead', status: res.status }, 502);
    const html = await res.text();
    const id = pickId(html, q);
    if (!id) return json({ q: q, id: null });
    return json({ q: q, id: id });
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

function pickId(html, q) {
  const norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); };
  const want = norm(q);
  const rows = html.match(/\[\s*\d+\s*,\s*\d+\s*,\s*"[^"]{2,80}"/g) || [];
  const re = /"id":(\d+)[^}]{0,400}?"name":"([^"]{2,90})"/g;
  let m, first = null;
  while ((m = re.exec(html))) {
    const id = +m[1], name = m[2].replace(/^\d+/, '');
    if (norm(name) === want) return id;
    if (first === null) first = id;
  }
  const link = html.match(/\/item=(\d+)/);
  return first || (link ? +link[1] : null);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + CACHE_S }
  });
}
