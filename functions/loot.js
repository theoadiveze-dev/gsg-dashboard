// Historique de loot wowaudit — alimenté automatiquement par le module
// RCLootCouncil_wowaudit dès qu'un objet est attribué en raid.
//
// L'endpoint est /v1/loot_history/{id} où {id} est l'ID de saison keystone,
// à récupérer sur /v1/period.
//
//   /loot            → historique de la saison courante, normalisé
//   /loot?season=15  → force une saison
//   /loot?debug=1    → réponse brute de wowaudit (pour inspecter les champs)

const FN_BUILD = 'loot v1.25.0';
// La clé vit dans Cloudflare Pages (Variables and Secrets, nom WA_KEY) et n'est
// plus écrite dans le dépôt : la renouveler ne demande plus de toucher au code.
// KEY est posée au début de chaque requête, avant tout appel à wowaudit.
let KEY = '';
function setKey(env) { KEY = (env && env.WA_KEY ? String(env.WA_KEY) : '').trim(); return !!KEY; }
const NO_KEY = { error: 'cle_absente', detail: "WA_KEY n'est pas définie sur ce déploiement. Cloudflare Pages → Settings → Variables and secrets (Production), puis nouveau déploiement." };
const CACHE_S = 600;

export async function onRequest(context) {
  if (!setKey(context.env)) return json(Object.assign({ build: FN_BUILD }, NO_KEY), 500);
  const url = new URL(context.request.url);
  try {
    let season = url.searchParams.get('season');
    let period = null;
    if (!season) {
      const p = await call('/v1/period');
      if (p.status !== 200) return json({ build: FN_BUILD, error: 'period', status: p.status, body: p.text.slice(0, 300) }, 502);
      try { period = JSON.parse(p.text); } catch (e) { return json({ error: 'period_parse', body: p.text.slice(0, 300) }, 502); }
      // /v1/period renvoie la saison comme objet ({id, name, ...}) : on veut l'ID.
      const cand = [period.season, period.current_season, period.current && period.current.season];
      for (const c of cand) {
        if (c && typeof c === 'object' && c.id) { season = c.id; break; }
        if (typeof c === 'number' || (typeof c === 'string' && c)) { season = c; break; }
      }
      if (!season) season = period.season_id || period.keystone_season_id || null;
      if (!season) return json({ build: FN_BUILD, error: 'season_absente', period: period }, 502);
    }

    const r = await call('/v1/loot_history/' + season);
    if (r.status !== 200) return json({ build: FN_BUILD, error: 'loot_history', season: season, status: r.status, body: r.text.slice(0, 300) }, 502);

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
    headers: { Authorization: KEY, Accept: 'application/json' }
  }).then(function (res) {
    return res.text().then(function (t) { return { status: res.status, text: t }; });
  });
}

// Tolérante à la forme exacte : on ne garde que ce dont le journal a besoin.
function normalize(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw && raw.history_items) ? raw.history_items
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
