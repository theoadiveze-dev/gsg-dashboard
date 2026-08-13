// Données wowaudit : wishlists (Droptimizer) et, via /wowaudit?probe=1, un
// inventaire des champs réellement exposés par l'API — c'est ainsi qu'on
// détermine si l'ilvl existe côté wowaudit au lieu de le supposer.
const WA_KEY = '39e0aa80209ba13e7f54958b3553037f1a9cc8f1b6095a74facc93170c5be9f9';
const CACHE_S = 3600;
const UPGRADE_LABEL = { huge: 'Gros gain', big: 'Bon gain', medium: 'Gain moyen', small: 'Petit gain', tiny: 'Gain marginal', none: 'Aucun gain' };

export async function onRequest(context) {
  const url = new URL(context.request.url);
  try {
    const fresh = !!url.searchParams.get('fresh');
    const res = await fetch('https://wowaudit.com/v1/wishlists', {
      headers: { Authorization: WA_KEY, Accept: 'application/json' },
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
    exemple: first ? { name: first.name, realm: first.realm } : null
  };
  try {
    const r = await fetch('https://wowaudit.com/v1/characters', {
      headers: { Authorization: WA_KEY, Accept: 'application/json' }
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
