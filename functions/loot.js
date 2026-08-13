// Sonde v2 : /v1/loot existe (406 = négociation de contenu refusée, pas 404).
// On teste les combinaisons d'en-têtes et de paramètres pour trouver celle
// que wowaudit accepte.
//
//   /loot?probe=1  → matrice de tests
//   /loot          → première combinaison qui répond 200, normalisée

const WA_KEY = '39e0aa80209ba13e7f54958b3553037f1a9cc8f1b6095a74facc93170c5be9f9';
const CACHE_S = 900;

const HEADERS = [
  ['json', { Accept: 'application/json' }],
  ['json+ct', { Accept: 'application/json', 'Content-Type': 'application/json' }],
  ['any', { Accept: '*/*' }],
  ['none', {}],
  ['vnd', { Accept: 'application/vnd.api+json' }],
  ['ua', { Accept: 'application/json', 'User-Agent': 'giltsky-portal/1.0' }]
];

const QUERIES = ['', '?limit=50', '?season=2', '?page=1', '?raid_difficulty=mythic'];

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const base = url.searchParams.get('path') || '/v1/loot';

  try {
    if (url.searchParams.get('probe')) {
      const out = [];
      for (const [hname, h] of HEADERS) {
        for (const q of QUERIES) {
          const r = await call(base + q, h);
          out.push({ h: hname, q: q || '(rien)', status: r.status, sample: r.text.slice(0, 160) });
          if (r.status === 200) return json({ found: { path: base + q, headers: hname }, sample: r.text.slice(0, 1200), tried: out });
        }
      }
      return json({ found: null, tried: out });
    }

    for (const [, h] of HEADERS) {
      for (const q of QUERIES) {
        const r = await call(base + q, h);
        if (r.status !== 200) continue;
        let raw;
        try { raw = JSON.parse(r.text); } catch (e) { continue; }
        if (url.searchParams.get('debug')) return json({ path: base + q, raw: raw });
        return json({ fetchedAt: new Date().toISOString(), path: base + q, entries: normalize(raw) });
      }
    }
    return json({ error: 'endpoint', base: base }, 502);
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

function call(path, extra) {
  const headers = Object.assign({ Authorization: WA_KEY }, extra || {});
  return fetch('https://wowaudit.com' + path, { headers: headers }).then(function (res) {
    return res.text().then(function (t) { return { status: res.status, text: t }; });
  }).catch(function (e) {
    return { status: 0, text: String(e && e.message) };
  });
}

function normalize(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw && raw.loot) ? raw.loot
    : Array.isArray(raw && raw.entries) ? raw.entries
    : Array.isArray(raw && raw.loot_history) ? raw.loot_history
    : Array.isArray(raw && raw.history) ? raw.history
    : [];
  return list.map(function (l) {
    return {
      id: l.id || l.uid || null,
      date: String(l.date || l.awarded_at || l.time || '').slice(0, 10),
      character: l.character_name || l.character || l.winner || l.player || '',
      item: l.item_name || l.name || '',
      itemId: l.item_id || l.itemId || null,
      slot: l.slot || l.equip_location || '',
      boss: l.boss || l.encounter || l.instance || '',
      difficulty: l.difficulty || '',
      response: l.response || l.award_reason || l.note || ''
    };
  }).filter(function (l) { return l.item && l.character; });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  });
}
