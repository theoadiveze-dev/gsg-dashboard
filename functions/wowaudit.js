const WA_KEY = '39e0aa80209ba13e7f54958b3553037f1a9cc8f1b6095a74facc93170c5be9f9';
const CACHE_S = 3600;

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug');
  try {
    const res = await fetch('https://wowaudit.com/v1/wishlists', {
      headers: { Authorization: WA_KEY, Accept: 'application/json' },
      cf: { cacheTtl: CACHE_S, cacheEverything: true }
    });
    const text = await res.text();
    if (!res.ok) return json({ error: 'wowaudit', status: res.status, body: text.slice(0, 400) }, 502);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return json({ error: 'parse', body: text.slice(0, 400) }, 502); }
    if (debug) return json({ raw: raw });
    return json({ fetchedAt: new Date().toISOString(), characters: normalize(raw) });
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

function normalize(raw) {
  const src = Array.isArray(raw) ? raw : (raw.characters || raw.wishlists || raw.data || []);
  const list = Array.isArray(src) ? src : [];
  return list.map(function (c) {
    const items = [];
    collect(c.wishlists || c.wishlist || c.instances || c.items, items, '');
    return {
      name: c.name || c.character_name || c.character || '',
      realm: c.realm || c.realm_slug || '',
      updatedAt: c.last_updated || c.updated_at || c.report_date || null,
      items: items
    };
  }).filter(function (c) { return c.name; });
}

function collect(node, out, diff) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(function (n) { collect(n, out, diff); }); return; }
  if (typeof node !== 'object') return;

  if (node.difficulty && !node.name && !node.item_name) { collect(childrenOf(node), out, String(node.difficulty)); return; }

  const nm = node.item_name || node.name;
  const hasGain = node.dps_gain !== undefined || node.gain !== undefined || node.value !== undefined;
  if (nm && (hasGain || node.slot || node.item_id)) {
    out.push({
      item: nm,
      itemId: node.item_id || node.id || null,
      slot: node.slot || node.item_slot || '—',
      boss: node.boss || node.encounter || node.source || '—',
      gain: num(node.dps_gain !== undefined ? node.dps_gain : (node.gain !== undefined ? node.gain : node.value)),
      difficulty: String(node.difficulty || diff || '')
    });
    return;
  }
  Object.keys(node).forEach(function (k) {
    const v = node[k];
    if (v && typeof v === 'object') {
      const d = /mythic|heroic|normal/i.test(k) ? k : diff;
      collect(v, out, d);
    }
  });
}

function childrenOf(o) {
  return o.instances || o.wishlists || o.items || o.wishes || [];
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : Math.round(n);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + CACHE_S }
  });
}
