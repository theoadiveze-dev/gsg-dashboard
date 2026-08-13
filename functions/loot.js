// Historique de loot wowaudit (alimenté automatiquement par le module
// RCLootCouncil_wowaudit). Le chemin exact de l'endpoint n'est pas documenté
// publiquement : cette fonction sonde les candidats plausibles et renvoie
// celui qui répond, avec un échantillon de la charge utile.
//
//   /loot?probe=1   → teste tous les chemins, renvoie le tableau des résultats
//   /loot           → utilise le premier chemin qui répond et normalise
//   /loot?path=...  → force un chemin précis (une fois qu'on le connaît)

const WA_KEY = '39e0aa80209ba13e7f54958b3553037f1a9cc8f1b6095a74facc93170c5be9f9';
const CACHE_S = 900;
const CANDIDATES = [
  '/v1/loot_history',
  '/v1/loot',
  '/v1/loots',
  '/v1/wishlists/loot_history',
  '/v1/loot_history/raw',
  '/v1/historical_loot',
  '/v1/raid_loot',
  '/v1/team/loot_history',
  '/api/v1/loot_history',
  '/guild/eu/ysondre/gilt-sky-gaming/teams/main/loot/history.json'
];

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const forced = url.searchParams.get('path');
  const probe = !!url.searchParams.get('probe');

  try {
    if (probe) {
      const out = [];
      for (const p of CANDIDATES) {
        const r = await call(p);
        out.push({ path: p, status: r.status, sample: r.text.slice(0, 300) });
      }
      return json({ probe: out });
    }

    const paths = forced ? [forced] : CANDIDATES;
    for (const p of paths) {
      const r = await call(p);
      if (r.status !== 200) continue;
      let raw;
      try { raw = JSON.parse(r.text); } catch (e) { continue; }
      if (url.searchParams.get('debug')) return json({ path: p, raw: raw });
      return json({ fetchedAt: new Date().toISOString(), path: p, entries: normalize(raw) });
    }
    return json({ error: 'endpoint', tried: paths }, 502);
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

function call(path) {
  return fetch('https://wowaudit.com' + path, {
    headers: { Authorization: WA_KEY, Accept: 'application/json' }
  }).then(function (res) {
    return res.text().then(function (t) { return { status: res.status, text: t }; });
  }).catch(function (e) {
    return { status: 0, text: String(e && e.message) };
  });
}

// Tolérante à la forme : wowaudit peut renvoyer un tableau nu ou un objet
// enveloppe. On ne garde que ce dont le journal a besoin.
function normalize(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw && raw.loot) ? raw.loot
    : Array.isArray(raw && raw.entries) ? raw.entries
    : Array.isArray(raw && raw.loot_history) ? raw.loot_history
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
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + CACHE_S, 'Access-Control-Allow-Origin': '*' }
  });
}
