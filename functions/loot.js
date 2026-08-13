// Historique de loot wowaudit — alimenté automatiquement par le module
// RCLootCouncil_wowaudit dès qu'un objet est attribué en raid.
//
// L'endpoint est /v1/loot_history/{id} où {id} est l'ID de saison keystone,
// à récupérer sur /v1/period.
//
//   /loot            → historique de la saison courante, normalisé
//   /loot?season=15  → force une saison
//   /loot?debug=1    → réponse brute de wowaudit (pour inspecter les champs)

const FN_BUILD = 'loot v1.22.0';
const WA_KEY = '39e0aa80209ba13e7f54958b3553037f1a9cc8f1b6095a74facc93170c5be9f9';
const CACHE_S = 600;

export async function onRequest(context) {
  const url = new URL(context.request.url);
  try {
    let season = url.searchParams.get('season');
    let period = null;
    if (!season) {
      const p = await call('/v1/period');
      if (p.status !== 200) return json({ build: FN_BUILD, error: 'period', status: p.status, body: p.text.slice(0, 300) }, 502);
      try { period = JSON.parse(p.text); } catch (e) { return json({ error: 'period_parse', body: p.text.slice(0, 300) }, 502); }
      season = period.season || period.current_season || period.season_id ||
        (period.current && (period.current.season || period.current.season_id));
      if (!season) return json({ error: 'season_absente', period: period }, 502);
    }

    const r = await call('/v1/loot_history/' + season);
    if (r.status !== 200) return json({ error: 'loot_history', season: season, status: r.status, body: r.text.slice(0, 300) }, 502);

    let raw;
    try { raw = JSON.parse(r.text); } catch (e) { return json({ error: 'parse', body: r.text.slice(0, 300) }, 502); }
    if (url.searchParams.get('debug')) return json({ build: FN_BUILD, season: season, period: period, raw: raw });

    return json({ build: FN_BUILD, fetchedAt: new Date().toISOString(), season: season, entries: normalize(raw) });
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

function call(path) {
  return fetch('https://wowaudit.com' + path, {
    headers: { Authorization: WA_KEY, Accept: 'application/json' }
  }).then(function (res) {
    return res.text().then(function (t) { return { status: res.status, text: t }; });
  });
}

// Tolérante à la forme exacte : on ne garde que ce dont le journal a besoin.
function normalize(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw && raw.loot_history) ? raw.loot_history
    : Array.isArray(raw && raw.loot) ? raw.loot
    : Array.isArray(raw && raw.entries) ? raw.entries
    : Array.isArray(raw && raw.history) ? raw.history
    : [];
  return list.map(function (l) {
    const c = l.character || {};
    return {
      id: l.id || l.uid || null,
      date: String(l.date || l.awarded_at || l.looted_at || l.time || '').slice(0, 10),
      character: l.character_name || c.name || l.winner || l.player || (typeof l.character === 'string' ? l.character : ''),
      item: l.item_name || (l.item && l.item.name) || l.name || '',
      itemId: l.item_id || l.itemId || (l.item && l.item.id) || null,
      slot: l.slot || l.equip_location || (l.item && l.item.slot) || '',
      boss: l.boss || l.encounter || l.instance || '',
      difficulty: l.difficulty || l.raid_difficulty || '',
      response: l.response || l.award_reason || l.reason || l.note || ''
    };
  }).filter(function (l) { return l.item && l.character; });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': status ? 'no-store' : 'public, max-age=' + CACHE_S,
      'Access-Control-Allow-Origin': '*'
    }
  });
}
