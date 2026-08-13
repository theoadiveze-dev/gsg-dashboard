// Warcraft Logs API v2 (GraphQL) — lecture des rapports de la guilde.
//
// Cette fonction ne juge rien et ne comble aucun trou. Elle remonte des faits :
// la liste des rapports, les pulls, les morts avec le sort qui a tué et la
// seconde, les dégâts pris, les parses. Toute erreur HTTP de Warcraft Logs est
// propagée telle quelle (statut + extrait du corps) : jamais traduite en
// « guilde introuvable » ou en liste vide.
//
// Clés attendues dans les variables d'environnement Cloudflare Pages :
//   WCL_ID, WCL_SECRET          (obligatoires, type Secret)
//   WCL_GUILD, WCL_REALM, WCL_REGION   (optionnelles, défauts ci-dessous)
//
// Routes :
//   /wcl?probe=1                   → token OK ? guilde trouvée ? 5 derniers rapports
//   /wcl?reports=1[&limit=20]      → rapports de la guilde
//   /wcl?report=CODE               → soirée : pulls, joueurs, ilvl moyen
//   /wcl?deaths=CODE[&fight=3]     → morts, dans l'ordre, sort et seconde du pull
//   /wcl?damage=CODE[&fight=3]     → dégâts pris par joueur et par sort
//   /wcl?parses=CODE[&fight=3]     → classements dps/hps du rapport
//   /wcl?quota=1                   → points d'API restants sur l'heure
//   &debug=1                       → ajoute la réponse GraphQL brute

const FN_BUILD = 'wcl v1.3.0';
const API = 'https://www.warcraftlogs.com/api/v2/client';
const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const CACHE_S = 1800;
// Warcraft Logs limite par adresse IP, et les fonctions Cloudflare sortent par
// des IP partagées : on peut être bloqué sans avoir rien consommé. La seule
// défense est de ne jamais poser deux fois la même question. Les logs d'une
// soirée passée sont immuables, donc le cache peut être long.
const GQL_CACHE_S = 21600;
const DEF = { guild: 'Gilt Sky Gaming', realm: 'ysondre', region: 'EU' };

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const env = context.env || {};
  const dbg = !!url.searchParams.get('debug');

  if (!env.WCL_ID || !env.WCL_SECRET) {
    return json({
      build: FN_BUILD, error: 'cles_absentes',
      detail: 'WCL_ID et WCL_SECRET ne sont pas définies. Cloudflare Pages → Settings → Variables and secrets, type Secret, puis nouveau déploiement.',
      seen: { WCL_ID: !!env.WCL_ID, WCL_SECRET: !!env.WCL_SECRET }
    }, 500);
  }

  const guild = url.searchParams.get('guild') || env.WCL_GUILD || DEF.guild;
  const realm = slug(url.searchParams.get('realm') || env.WCL_REALM || DEF.realm);
  const region = (url.searchParams.get('region') || env.WCL_REGION || DEF.region).toUpperCase();

  try {
    if (url.searchParams.get('quota')) {
      const q = await run(env, Q_QUOTA, {});
      if (!q.ok) return json(Object.assign({ build: FN_BUILD }, q.err), q.err.httpStatus || 502);
      const r = path(q.json, ['data', 'rateLimitData']) || {};
      return json({
        build: FN_BUILD, fetchedAt: new Date().toISOString(),
        parHeure: r.limitPerHour, depenses: r.pointsSpentThisHour,
        restants: r.limitPerHour != null && r.pointsSpentThisHour != null ? Math.max(0, Math.round((r.limitPerHour - r.pointsSpentThisHour) * 100) / 100) : null,
        remiseAZeroDans: r.pointsResetIn != null ? r.pointsResetIn + ' s' : null
      });
    }

    if (url.searchParams.get('probe')) {
      const out = { build: FN_BUILD, fetchedAt: new Date().toISOString(), guild: guild, realm: realm || null, region: region };
      if (!realm) {
        out.error = 'royaume_absent';
        out.detail = 'Le royaume de la guilde est nécessaire. Appelle /wcl?probe=1&realm=ysondre ou définis WCL_REALM.';
        return json(out, 400);
      }
      const q = await run(env, Q_REPORTS, { g: guild, s: realm, r: region, limit: 5 });
      if (!q.ok) return json(Object.assign(out, q.err), q.err.httpStatus || 502);
      out.oauth = 'ok';
      const list = path(q.json, ['data', 'reportData', 'reports', 'data']) || [];
      out.guildFound = list.length > 0;
      out.reportCount = list.length;
      out.reports = list.map(mapReport);
      if (!list.length) {
        out.detail = 'Warcraft Logs a répondu correctement mais ne renvoie aucun rapport pour ' + guild + ' — ' + realm + ' (' + region + '). Vérifie le nom exact de la guilde et le slug du royaume.';
      }
      if (dbg) out.raw = q.json;
      return json(out);
    }

    if (url.searchParams.get('reports')) {
      if (!realm) return json({ build: FN_BUILD, error: 'royaume_absent' }, 400);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);
      const q = await run(env, Q_REPORTS, { g: guild, s: realm, r: region, limit: limit });
      if (!q.ok) return json(Object.assign({ build: FN_BUILD }, q.err), q.err.httpStatus || 502);
      const list = path(q.json, ['data', 'reportData', 'reports', 'data']) || [];
      return json({ build: FN_BUILD, fetchedAt: new Date().toISOString(), guild: guild, realm: realm, region: region, reportCount: list.length, reports: list.map(mapReport) });
    }

    const code = url.searchParams.get('report') || url.searchParams.get('deaths')
      || url.searchParams.get('damage') || url.searchParams.get('parses');
    if (!code) return json({ build: FN_BUILD, error: 'parametre_absent', detail: 'Attendu : probe, reports, report, deaths, damage ou parses.' }, 400);

    const fightParam = url.searchParams.get('fight');
    const fightIDs = fightParam ? fightParam.split(',').map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }) : null;

    // Toutes les routes de détail ont besoin du squelette du rapport :
    // acteurs et sorts servent à traduire les IDs en noms.
    const base = await run(env, Q_REPORT, { code: code });
    if (!base.ok) return json(Object.assign({ build: FN_BUILD, code: code }, base.err), base.err.httpStatus || 502);
    const rep = path(base.json, ['data', 'reportData', 'report']);
    if (!rep) {
      return json({
        build: FN_BUILD, error: 'rapport_introuvable', code: code,
        detail: 'Warcraft Logs a répondu sans erreur mais ne connaît pas ce code de rapport.'
      }, 404);
    }

    const actors = {}, abilities = {};
    (path(rep, ['masterData', 'actors']) || []).forEach(function (a) { actors[a.id] = a; });
    (path(rep, ['masterData', 'abilities']) || []).forEach(function (a) { abilities[a.gameID] = a; });
    const fights = (rep.fights || []).map(mapFight);
    const window = pickWindow(rep, fights, fightIDs);
    const head = {
      build: FN_BUILD, fetchedAt: new Date().toISOString(), code: code,
      title: rep.title, zone: rep.zone && rep.zone.name,
      startTime: rep.startTime, endTime: rep.endTime
    };

    if (url.searchParams.get('report')) {
      const out = Object.assign(head, {
        players: Object.keys(actors).map(function (k) { return actors[k]; })
          .filter(function (a) { return a.type === 'Player'; })
          .map(function (a) { return { id: a.id, name: a.name, classe: a.subType, realm: a.server || '' }; }),
        fights: fights,
        kills: fights.filter(function (f) { return f.kill; }).length,
        wipes: fights.filter(function (f) { return f.boss && !f.kill; }).length
      });
      if (dbg) out.raw = rep;
      return json(out);
    }

    if (url.searchParams.get('deaths')) {
      const q = await run(env, Q_DEATHS, { code: code, start: window.start, end: window.end });
      if (!q.ok) return json(Object.assign({ build: FN_BUILD, code: code }, q.err), q.err.httpStatus || 502);
      const raw = path(q.json, ['data', 'reportData', 'report', 'events', 'data']) || [];
      const out = Object.assign(head, {
        fight: fightIDs, window: window,
        deaths: raw.map(function (e) {
          const who = actors[e.targetID], by = actors[e.killerID || e.sourceID];
          const abilityID = e.killingAbilityGameID || e.abilityGameID
            || (e.killingAbility && e.killingAbility.guid) || (e.ability && e.ability.guid) || null;
          const ab = abilityID ? abilities[abilityID] : null;
          return {
            t: e.timestamp,
            fight: e.fight != null ? e.fight : null,
            secondesDansLePull: fightOffset(fights, e),
            joueur: who ? who.name : null,
            classe: who ? who.subType : null,
            sortId: abilityID,
            sort: ab ? ab.name : null,
            source: by ? by.name : null
          };
        })
      });
      // Les champs exacts d'un événement de mort varient : en cas de trou,
      // debug=1 montre la charge brute plutôt que de laisser deviner.
      if (dbg) out.raw = raw.slice(0, 20);
      return json(out);
    }

    if (url.searchParams.get('damage')) {
      const q = await run(env, Q_TABLE, { code: code, start: window.start, end: window.end, type: 'DamageTaken' });
      if (!q.ok) return json(Object.assign({ build: FN_BUILD, code: code }, q.err), q.err.httpStatus || 502);
      const t = path(q.json, ['data', 'reportData', 'report', 'table']);
      const entries = path(t, ['data', 'entries']) || [];
      const out = Object.assign(head, {
        fight: fightIDs, window: window,
        joueurs: entries.map(function (e) {
          return {
            joueur: e.name, classe: e.type || e.icon || '', total: e.total,
            parSort: (e.abilities || []).map(function (a) {
              return { sort: a.name, total: a.total, coups: a.hitCount != null ? a.hitCount : a.uses };
            }).sort(function (a, b) { return (b.total || 0) - (a.total || 0); }).slice(0, 12)
          };
        }).sort(function (a, b) { return (b.total || 0) - (a.total || 0); })
      });
      if (dbg) out.raw = t && t.data;
      return json(out);
    }

    // parses
    const q = await run(env, Q_RANKS, { code: code, ids: fightIDs });
    if (!q.ok) return json(Object.assign({ build: FN_BUILD, code: code }, q.err), q.err.httpStatus || 502);
    const rk = path(q.json, ['data', 'reportData', 'report', 'rankings']);
    return json(Object.assign(head, {
      fight: fightIDs,
      rankings: rk && rk.data ? rk.data : (rk || null),
      raw: dbg ? rk : undefined
    }));
  } catch (e) {
    return json({
      build: FN_BUILD, error: 'exception',
      detail: 'La fonction a levé une exception avant de pouvoir répondre.',
      message: String(e && e.message).slice(0, 300)
    }, 502);
  }
}

// ─────────────────────────────── GraphQL

const Q_REPORTS = `query($g:String!,$s:String!,$r:String!,$limit:Int!){
  reportData{ reports(guildName:$g, guildServerSlug:$s, guildServerRegion:$r, limit:$limit){
    data{ code title startTime endTime zone{ id name } owner{ name } }
  } }
}`;

const Q_REPORT = `query($code:String!){
  reportData{ report(code:$code){
    title startTime endTime zone{ id name }
    masterData(translate:true){
      actors(type:"Player"){ id name subType server type }
      abilities{ gameID name type }
    }
    fights{ id name encounterID difficulty kill fightPercentage bossPercentage
            startTime endTime averageItemLevel friendlyPlayers lastPhase }
  } }
}`;

const Q_DEATHS = `query($code:String!,$start:Float!,$end:Float!){
  reportData{ report(code:$code){
    events(dataType: Deaths, startTime:$start, endTime:$end, limit:500){ data nextPageTimestamp }
  } }
}`;

const Q_TABLE = `query($code:String!,$start:Float!,$end:Float!,$type:TableDataType!){
  reportData{ report(code:$code){ table(dataType:$type, startTime:$start, endTime:$end) } }
}`;

const Q_QUOTA = `query{ rateLimitData{ limitPerHour pointsSpentThisHour pointsResetIn } }`;

const Q_RANKS = `query($code:String!,$ids:[Int]){
  reportData{ report(code:$code){ rankings(fightIDs:$ids) } }
}`;

// Un appel GraphQL, token compris. Un 401 signifie presque toujours un token
// mis en cache devenu invalide : on le jette et on retente une fois. Tout autre
// statut non-200 remonte tel quel — le front doit pouvoir dire « WCL a répondu
// 429 » et non « aucun rapport ».
async function run(env, query, variables, retried) {
  const ck = new Request('https://wcl-gql.internal/' + hash(query + '|' + JSON.stringify(variables || {})));
  if (!retried) {
    try {
      const hit = await caches.default.match(ck);
      if (hit) { const j = await hit.json(); if (j && j.data) return { ok: true, json: j, cached: true }; }
    } catch (e) { /* cache indisponible */ }
  }

  const tok = await getToken(env, !!retried);
  if (!tok.ok) {
    return { ok: false, err: { error: 'oauth', detail: 'Warcraft Logs a refusé les identifiants (' + tok.status + ').', status: tok.status, body: tok.body, httpStatus: 502 } };
  }

  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok.value, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: query, variables: variables })
  });
  const text = await res.text();

  if (res.status === 401 && !retried) {
    await dropToken(env);
    return run(env, query, variables, true);
  }

  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = null; }

  if (res.status !== 200) {
    return {
      ok: false, err: {
        error: 'wcl_http', status: res.status,
        detail: res.status === 429 ? (/ip address/i.test(text)
            ? 'Warcraft Logs bloque temporairement l’adresse IP de sortie de Cloudflare — elle est partagée. Réessaie dans quelques minutes ; les soirées déjà consultées restent lisibles depuis le cache.'
            : 'Quota Warcraft Logs épuisé pour l’heure en cours — /wcl?quota=1 donne les points restants.')
          : res.status === 401 || res.status === 403 ? 'Warcraft Logs a refusé l’accès (clé ou droits).'
          : 'Warcraft Logs a répondu ' + res.status + '.',
        body: text.slice(0, 400), httpStatus: 502
      }
    };
  }
  if (!body) {
    return { ok: false, err: { error: 'reponse_non_json', detail: 'Réponse illisible de Warcraft Logs.', body: text.slice(0, 400), httpStatus: 502 } };
  }
  if (body.errors) {
    return { ok: false, err: { error: 'graphql', detail: 'Requête refusée par Warcraft Logs.', errors: body.errors, httpStatus: 502 } };
  }
  if (!body.data) {
    return { ok: false, err: { error: 'reponse_vide', detail: 'Warcraft Logs a répondu 200 sans données.', body: text.slice(0, 400), httpStatus: 502 } };
  }
  try {
    await caches.default.put(ck, new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + GQL_CACHE_S }
    }));
  } catch (e) { /* pas grave */ }
  return { ok: true, json: body };
}

function tokenKey(env) { return new Request('https://wcl-token.internal/' + hash(env.WCL_ID)); }

async function dropToken(env) {
  try { await caches.default.delete(tokenKey(env)); } catch (e) { /* rien à jeter */ }
}

// Le token client_credentials vit longtemps : on le garde dans le cache de
// l'edge pour ne pas rappeler l'OAuth à chaque requête.
async function getToken(env, fresh) {
  const key = tokenKey(env);
  const cache = caches.default;
  if (!fresh) {
    try {
      const hit = await cache.match(key);
      if (hit) { const j = await hit.json(); if (j && j.access_token) return { ok: true, value: j.access_token }; }
    } catch (e) { /* cache indisponible : on redemande */ }
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.WCL_ID + ':' + env.WCL_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });
  const text = await res.text();
  if (res.status !== 200) return { ok: false, status: res.status, body: text.slice(0, 300) };
  let j; try { j = JSON.parse(text); } catch (e) { return { ok: false, status: res.status, body: text.slice(0, 300) }; }
  if (!j.access_token) return { ok: false, status: res.status, body: text.slice(0, 300) };
  try {
    const ttl = Math.min(j.expires_in || 3600, 43200);
    await cache.put(key, new Response(JSON.stringify({ access_token: j.access_token }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl }
    }));
  } catch (e) { /* pas grave */ }
  return { ok: true, value: j.access_token };
}

// ─────────────────────────────── helpers

function path(obj, keys) {
  let cur = obj;
  for (let i = 0; i < keys.length; i++) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[keys[i]];
  }
  return cur == null ? null : cur;
}

function mapReport(r) {
  return {
    code: r.code, titre: r.title,
    debut: r.startTime, fin: r.endTime,
    date: new Date(r.startTime).toISOString().slice(0, 10),
    zone: r.zone && r.zone.name, zoneId: r.zone && r.zone.id,
    par: r.owner && r.owner.name,
    url: 'https://www.warcraftlogs.com/reports/' + r.code
  };
}

const DIFF = { 1: 'LFR', 3: 'Normal', 4: 'Héroïque', 5: 'Mythique' };

function mapFight(f) {
  return {
    id: f.id, nom: f.name, encounterID: f.encounterID,
    boss: !!f.encounterID,
    difficulte: DIFF[f.difficulty] || (f.difficulty != null ? String(f.difficulty) : ''),
    kill: !!f.kill,
    restant: f.fightPercentage != null ? f.fightPercentage / 100 : null,
    phase: f.lastPhase != null ? f.lastPhase : null,
    debut: f.startTime, fin: f.endTime,
    duree: f.endTime != null && f.startTime != null ? Math.round((f.endTime - f.startTime) / 1000) : null,
    ilvl: f.averageItemLevel, joueurs: (f.friendlyPlayers || []).length
  };
}

function pickWindow(rep, fights, ids) {
  if (ids && ids.length) {
    const sel = fights.filter(function (f) { return ids.indexOf(f.id) !== -1; });
    if (sel.length) {
      return {
        start: Math.min.apply(null, sel.map(function (f) { return f.debut; })),
        end: Math.max.apply(null, sel.map(function (f) { return f.fin; }))
      };
    }
  }
  return { start: 0, end: (rep.endTime - rep.startTime) + 1 };
}

function fightOffset(fights, e) {
  if (e.fight == null || e.timestamp == null) return null;
  for (let i = 0; i < fights.length; i++) {
    if (fights[i].id === e.fight) return Math.round((e.timestamp - fights[i].debut) / 100) / 10;
  }
  return null;
}

// « Hyjal » → « hyjal », « Twisting Nether » → « twisting-nether »
function slug(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '').replace(/\s+/g, '-');
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) { h = (h * 31 + String(s).charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
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
