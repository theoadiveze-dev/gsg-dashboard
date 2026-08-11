const WA_KEY = '39e0aa80209ba13e7f54958b3553037f1a9cc8f1b6095a74facc93170c5be9f9';
const CACHE_S = 3600;
const UPGRADE_LABEL = { huge: 'Gros gain', big: 'Bon gain', medium: 'Gain moyen', small: 'Petit gain', tiny: 'Gain marginal', none: 'Aucun gain' };

export async function onRequest(context) {
  const url = new URL(context.request.url);
  try {
    const res = await fetch('https://wowaudit.com/v1/wishlists', {
      headers: { Authorization: WA_KEY, Accept: 'application/json' },
      cf: { cacheTtl: CACHE_S, cacheEverything: true }
    });
    const text = await res.text();
    if (!res.ok) return json({ error: 'wowaudit', status: res.status, body: text.slice(0, 400) }, 502);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return json({ error: 'parse', body: text.slice(0, 400) }, 502); }
    if (url.searchParams.get('debug')) return json({ raw: raw });
    return json({ fetchedAt: new Date().toISOString(), characters: normalize(raw) });
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

function normalize(raw) {
  const chars = (raw && raw.characters) || [];
  return chars.map(function (c) {
    const items = [];
    let updated = null;
    (c.instances || []).forEach(function (inst) {
      (inst.difficulties || []).forEach(function (df) {
        const wl = df.wishlist || {};
        Object.keys(wl.updated_at || {}).forEach(function (spec) {
          const d = wl.updated_at[spec];
          if (d && (!updated || d > updated)) updated = d;
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
    return { name: c.name || '', realm: c.realm || '', updatedAt: updated, items: items };
  }).filter(function (c) { return c.name; });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + CACHE_S }
  });
}
