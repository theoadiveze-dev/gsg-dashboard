// Données wowaudit : wishlists (Droptimizer) et, via /wowaudit?probe=1, un
// inventaire des champs réellement exposés par l'API — c'est ainsi qu'on
// détermine si l'ilvl existe côté wowaudit au lieu de le supposer.
// La clé vit dans Cloudflare Pages (Variables and Secrets, nom WA_KEY) et n'est
// plus écrite dans le dépôt : la renouveler ne demande plus de toucher au code.
// KEY est posée au début de chaque requête, avant tout appel à wowaudit.
let KEY = '';
function setKey(env) { KEY = (env && env.WA_KEY ? String(env.WA_KEY) : '').trim(); return !!KEY; }
const NO_KEY = { error: 'cle_absente', detail: "WA_KEY n'est pas définie sur ce déploiement. Cloudflare Pages → Settings → Variables and secrets (Production), puis nouveau déploiement." };
const CACHE_S = 3600;
const UPGRADE_LABEL = { huge: 'Gros gain', big: 'Bon gain', medium: 'Gain moyen', small: 'Petit gain', tiny: 'Gain marginal', none: 'Aucun gain' };

const FN_BUILD = 'wowaudit v1.9.0';
export async function onRequest(context) {
  if (!setKey(context.env)) return json(NO_KEY, 500);
  const url = new URL(context.request.url);
  // Exploration : /wowaudit?path=/v1/xxx renvoie la réponse brute d'un endpoint
  // wowaudit. Sert à trouver où vit le tier-status sans deviner.
  const raw = url.searchParams.get('path');
  if (raw) {
    if (!/^\/v1\//.test(raw)) return json({ error: 'chemin_refuse', detail: 'Seuls les chemins /v1/… sont autorisés.' }, 400);
    const r = await fetch('https://wowaudit.com' + raw, { headers: { Authorization: KEY, Accept: 'application/json' } });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) { j = null; }
    return json({ build: FN_BUILD, path: raw, status: r.status, json: j, body: j ? undefined : t.slice(0, 600) }, r.ok ? 200 : 502, 0);
  }
  try {
    const fresh = !!url.searchParams.get('fresh');
    const res = await fetch('https://wowaudit.com/v1/wishlists', {
      headers: { Authorization: KEY, Accept: 'application/json' },
      cf: fresh ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: CACHE_S, cacheEverything: true }
    });
    const text = await res.text();
    if (!res.ok) return json({ error: 'wowaudit', status: res.status, body: text.slice(0, 400) }, 502);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return json({ error: 'parse', body: text.slice(0, 400) }, 502); }
    if (url.searchParams.get('debug')) return json({ raw: raw });
    if (url.searchParams.get('probe')) return json(await probe(raw));
    return json({ fetchedAt: new Date().toISOString(), characters: normalize(raw) }, 200, fresh);
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

// Quels champs wowaudit expose-t-il vraiment ? On liste les clés du premier
// personnage de /v1/wishlists et de /v1/characters, plus toute clé dont le nom
// évoque un niveau d'objet, avec sa valeur. Aucune interprétation.
async function probe(wishRaw) {
  const out = { source: 'wowaudit', fetchedAt: new Date().toISOString() };
  const first = ((wishRaw && wishRaw.characters) || [])[0] || null;
  out.wishlists = {
    personnages: ((wishRaw && wishRaw.characters) || []).length,
    clesTopNiveau: Object.keys(wishRaw || {}),
    clesPersonnage: first ? Object.keys(first) : [],
    champsNiveau: first ? levelish(first) : {},
    // Un objet de wishlist tel que wowaudit l'envoie : c'est là qu'on lit si le
    // tier est marqué, et sous quel nom de champ.
    objet: (function () {
      const it = firstItem(wishRaw);
      return it ? { cles: Object.keys(it), brut: it } : null;
    })(),
    exemple: first ? { name: first.name, realm: first.realm } : null
  };
  try {
    const r = await fetch('https://wowaudit.com/v1/characters', {
      headers: { Authorization: KEY, Accept: 'application/json' }
    });
    const t = await r.text();
    out.characters = { status: r.status };
    if (r.ok) {
      let raw = null;
      try { raw = JSON.parse(t); } catch (e) { raw = null; }
      const list = Array.isArray(raw) ? raw : (raw && raw.characters) || [];
      const c0 = list[0] || null;
      out.characters.nombre = list.length;
      out.characters.clesPersonnage = c0 ? Object.keys(c0) : [];
      out.characters.champsNiveau = c0 ? levelish(c0) : {};
      out.characters.exemple = c0 || null;
    } else {
      out.characters.body = t.slice(0, 300);
    }
  } catch (e) {
    out.characters = { error: String(e && e.message).slice(0, 200) };
  }
  return out;
}

// Toute clé qui parle de niveau, d'équipement ou de spé, à un niveau de
// profondeur, avec sa valeur brute.
function levelish(obj) {
  const hit = {};
  const scan = function (o, prefix, depth) {
    if (!o || typeof o !== 'object' || depth > 2) return;
    Object.keys(o).forEach(function (k) {
      const v = o[k], path = prefix ? prefix + '.' + k : k;
      if (/level|ilvl|gear|equip|spec|role|class/i.test(k) && (typeof v !== 'object' || v === null)) hit[path] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) scan(v, path, depth + 1);
    });
  };
  scan(obj, '', 0);
  return hit;
}

// Premier objet de wishlist trouvé, dans n'importe quelle instance.
function firstItem(raw) {
  const chars = (raw && raw.characters) || [];
  for (const c of chars) {
    for (const inst of c.instances || []) {
      for (const df of inst.difficulties || []) {
        const wl = df.wishlist || {};
        for (const enc of wl.encounters || []) {
          if ((enc.items || []).length) return enc.items[0];
        }
        for (const k of Object.keys(wl)) {
          if (/trinket/i.test(k) && Array.isArray(wl[k]) && wl[k].length) return wl[k][0];
        }
      }
    }
  }
  return null;
}

function setFlag(it) {
  // wowaudit ne documente pas un champ unique pour le tier : on accepte toutes
  // les formes plausibles et on expose le résultat tel quel.
  const keys = ['tier_set', 'tierset', 'is_tier', 'is_tier_set', 'set', 'set_item', 'item_set', 'tier', 'set_id', 'set_name'];
  for (const k of keys) {
    const v = it[k];
    if (v === true) return true;
    if (typeof v === 'number' && v > 0) return true;
    if (typeof v === 'string' && v.trim()) return true;
    if (v && typeof v === 'object') return true;
  }
  return false;
}

function normalize(raw) {
  const chars = (raw && raw.characters) || [];
  return chars.map(function (c) {
    const items = [];
    let updated = null;
    const specDates = {};
    (c.instances || []).forEach(function (inst) {
      (inst.difficulties || []).forEach(function (df) {
        const wl = df.wishlist || {};
        Object.keys(wl.updated_at || {}).forEach(function (spec) {
          const d = wl.updated_at[spec];
          if (!d) return;
          if (!updated || d > updated) updated = d;
          const key = spec + ' · ' + (df.difficulty || '');
          if (!specDates[key] || d > specDates[key]) specDates[key] = d;
        });
        Object.keys(wl).forEach(function (k) {
          if (!/trinket/i.test(k) || !Array.isArray(wl[k])) return;
          wl[k].forEach(function (it) {
            (it.wishes || []).forEach(function (w) {
              items.push({
                item: it.name, itemId: it.id || null, slot: it.slot || 'Bijou',
                tierSet: setFlag(it),
                boss: it.boss || it.source || '—', raid: inst.name || '',
                spec: w.specialization || '', difficulty: df.difficulty || '',
                pct: typeof w.percentage === 'number' ? Math.round(w.percentage * 10) / 10 : null,
                abs: typeof w.absolute === 'number' ? Math.round(w.absolute) : null,
                upgrade: UPGRADE_LABEL[w.upgrade] || w.upgrade || null,
                manual: !!w.manually_edited, outdated: !!w.outdated
              });
            });
          });
        });
        (wl.encounters || []).forEach(function (enc) {
          (enc.items || []).forEach(function (it) {
            (it.wishes || []).forEach(function (w) {
              items.push({
                item: it.name,
                itemId: it.id || null,
                slot: it.slot || '—',
                tierSet: setFlag(it),
                boss: enc.name || '—',
                raid: inst.name || '',
                spec: w.specialization || '',
                difficulty: df.difficulty || '',
                pct: typeof w.percentage === 'number' ? Math.round(w.percentage * 10) / 10 : null,
                abs: typeof w.absolute === 'number' ? Math.round(w.absolute) : null,
                upgrade: UPGRADE_LABEL[w.upgrade] || w.upgrade || null,
                manual: !!w.manually_edited,
                outdated: !!w.outdated
              });
            });
          });
        });
      });
    });
    return { name: c.name || '', realm: c.realm || '', updatedAt: updated, specDates: specDates, items: items };
  }).filter(function (c) { return c.name; });
}

function json(obj, status, noStore) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': noStore ? 'no-store' : 'public, max-age=' + CACHE_S, 'Access-Control-Allow-Origin': '*' }
  });
}
