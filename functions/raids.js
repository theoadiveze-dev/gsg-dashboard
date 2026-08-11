const WA_KEY = '39e0aa80209ba13e7f54958b3553037f1a9cc8f1b6095a74facc93170c5be9f9';
const CACHE_S = 900;
const SEASON_START = '2026-08-19';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug');
  try {
    const list = await wa('/v1/raids?include_past=true');
    if (list.error) return json(list, 502);
    if (debug === 'list') return json({ raw: list });

    const all = (Array.isArray(list) ? list : list.raids || []).filter(function (r) {
      return String(r.date || '') >= SEASON_START && r.instance;
    });
    const horizon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const near = all.filter(function (r) { return String(r.date) <= horizon; }).slice(0, 15);
    const details = {};
    for (const r of near) {
      const d = await wa('/v1/raids/' + r.id);
      if (d && !d.error) details[r.id] = d;
    }
    if (debug === 'one') return json({ raw: details[near[0] && near[0].id] || null });

    return json({ fetchedAt: new Date().toISOString(), raids: all.map(function (r) { return norm(r, details[r.id]); }) });
  } catch (e) {
    return json({ error: 'network', message: String(e && e.message).slice(0, 200) }, 502);
  }
}

async function wa(path) {
  const res = await fetch('https://wowaudit.com' + path, {
    headers: { Authorization: WA_KEY, Accept: 'application/json' },
    cf: { cacheTtl: CACHE_S, cacheEverything: true }
  });
  const text = await res.text();
  if (!res.ok) return { error: 'wowaudit', status: res.status, path: path, body: text.slice(0, 300) };
  try { return JSON.parse(text); } catch (e) { return { error: 'parse', path: path, body: text.slice(0, 300) }; }
}

function norm(r, det) {
  const d = det || {};
  const signups = (d.signups || d.characters || r.signups || []).map(function (s) {
    const st = String(s.status || s.signup_status || '').toLowerCase();
    return {
      name: s.name || s.character_name || (s.character && s.character.name) || '',
      role: s.role || (s.character && s.character.role) || '',
      klass: s.class || (s.character && s.character.class) || '',
      status: /present|confirmed|accept|selected|yes/.test(st) ? 'inscrit'
        : /absent|declin|no/.test(st) ? 'absent'
        : /tentative|maybe|late|bench/.test(st) ? 'attente' : (st || 'attente'),
      selected: !!(s.selected || s.status === 'present')
    };
  }).filter(function (s) { return s.name; });

  return {
    id: r.id,
    date: r.date || '',
    startTime: r.start_time && r.start_time !== '00:00' ? r.start_time : '20:30',
    endTime: r.end_time && r.end_time !== '00:00' ? r.end_time : '00:00',
    title: r.name || r.instance || '',
    difficulty: r.difficulty || '',
    present: signups.length ? signups.filter(function (s) { return s.status === 'inscrit'; }).length : (r.present_size || 0),
    total: r.total_size || 0,
    status: r.status || '',
    detailed: !!det,
    signups: signups
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + CACHE_S }
  });
}
