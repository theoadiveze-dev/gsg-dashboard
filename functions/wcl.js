// Warcraft Logs API v2 (GraphQL) — lecture des rapports de la guilde.
//
// Cette fonction ne juge rien. Elle remonte des faits : la liste des rapports,
// les pulls d'un rapport, les morts avec le sort qui a tué et la seconde, les
// dégâts pris par joueur, les parses. L'interprétation (« évitable ou non »)
// se fait côté tableau de bord, avec une table par boss validée à la main.
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
//   &debug=1                       → ajoute la réponse GraphQL brute

const FN_BUILD = 'wcl v1.0.0';
const API = 'https://www.warcraftlogs.com/api/v2/client';
const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const CACHE_S = 300;
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
    const token = await getToken(env);
    if (!token.ok) return json({ build: FN_BUILD, error: 'oauth', status: token.status, body: token.body }, 502);

    if (url.searchParams.get('probe')) {
      const out = { build: FN_BUILD, fetchedAt: new Date().toISOString(), oauth: 'ok', guild: guild, realm: realm || null, region: region };
      if (!realm) {
        out.error = 'royaume_absent';
        out.detail = 'Le royaume de la guilde est nécessaire. Appelle /wcl?probe=1&realm=hyjal ou définis WCL_REALM.';
        return json(out, 400);
      }
      const q = await gql(token.value, Q_REPORTS, { g: guild, s: realm, r: region, limit: 5 });
      if (q.errors) { out.error = 'graphql'; out.errors = q.errors; return json(out, 502); }
      const node = q.data && q.data.reportData && q.data.reportData.reports;
      const list = (node && node.data) || [];
      out.guildFound = list.length > 0;
      out.reportCount = list.length;
      out.reports = list.map(mapReport);
      if (!list.length) out.detail = 'Aucun rapport : vérifie le nom exact de la guilde, le slug du royaume et la région.';
      if (dbg) out.raw = q.data;
      return json(out);
    }

    if (url.searchParams.get('reports')) {
      if (!realm) return json({ build: FN_BUILD, error: 'royaume_absent' }, 400);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);
      const q = await gql(token.value, Q_REPORTS, { g: guild, s: realm, r: region, limit: limit });
      if (q.errors) return json({ build: FN_BUILD, error: 'graphql', errors: q.errors }, 502);
      const list = ((q.data.reportData.reports || {}).data) || [];
      return json({ build: FN_BUILD, fetchedAt: new Date().toISOString(), guild: guild, realm: realm, region: region, reports: list.map(mapReport) });
    }

    const code = url.searchParams.get('report') || url.searchParams.get('deaths')
      || url.searchParams.get('damage') || url.searchParams.get('parses');
    if (!code) return json({ build: FN_BUILD, error: 'parametre_absent', detail: 'Attendu : probe, reports, report, deaths, damage ou parses.' }, 400);

    const fightParam = url.searchParams.get('fight');
    const fightIDs = fightParam ? fightParam.split(',').map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }) : null;

    // Toutes les routes de détail ont besoin du squelette du rapport :
    // acteurs et sorts servent à traduire les IDs en noms.
    const base = await gql(token.value, Q_REPORT, { code: code });
    if (base.errors) return json({ build: FN_BUILD, error: 'graphql', errors: base.errors }, 502);
    const rep = base.data && base.data.reportData && base.data.reportData.report;
    if (!rep) return json({ build: FN_BUILD, error: 'rapport_introuvable', code: code }, 404);

    const actors = {}, abilities = {};
    ((rep.masterData && rep.masterData.actors) || []).forEach(function (a) { actors[a.id] = a; });
    ((rep.masterData && rep.masterData.abilities) || []).forEach(function (a) { abilities[a.gameID] = a; });
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
      const q = await gql(token.value, Q_DEATHS, { code: code, start: window.start, end: window.end });
      if (q.errors) return json({ build: FN_BUILD, error: 'graphql', errors: q.errors }, 502);
      const ev = q.data.reportData.report.events;
      const raw = (ev && ev.data) || [];
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
      const q = await gql(token.value, Q_TABLE, {
        code: code, start: window.start, end: window.end, type: 'DamageTaken'
      });
      if (q.errors) return json({ build: FN_BUILD, error: 'graphql', errors: q.errors }, 502);
      const t = q.data.reportData.report.table;
      const entries = (t && t.data && t.data.entries) || [];
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
    const q = await gql(token.value, Q_RANKS, { code: code, ids: fightIDs });
    if (q.errors) return json({ build: FN_BUILD, error: 'graphql', errors: q.errors }, 502);
    const rk = q.data.reportData.report.rankings;
    return json(Object.assign(head, { fight: fightIDs, rankings: rk && rk.data ? rk.data : rk, raw: dbg ? rk : undefined }));
  } catch (e) {
    return json({ build: FN_BUILD, error: 'reseau', message: String(e && e.message).slice(0, 300) }, 502);
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

const Q_RANKS = `query($code:String!,$ids:[Int]){
  reportData{ report(code:$code){ rankings(fightIDs:$ids) } }
}`;

function gql(token, query, variables) {
  return fetch(API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: query, variables: variables })
  }).then(function (res) {
    return res.text().then(function (t) {
      try { return JSON.parse(t); }
      catch (e) { return { errors: [{ message: 'reponse_non_json', status: res.status, body: t.slice(0, 300) }] }; }
    });
  });
}

// Le token client_credentials vit longtemps : on le garde dans le cache de
// l'edge pour ne pas rappeler l'OAuth à chaque requête.
async function getToken(env) {
  const key = new Request('https://wcl-token.internal/' + hash(env.WCL_ID));
  const cache = caches.default;
  try {
    const hit = await cache.match(key);
    if (hit) { const j = await hit.json(); if (j && j.access_token) return { ok: true, value: j.access_token }; }
  } catch (e) { /* cache indisponible : on redemande */ }

  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.WCL_ID + ':' + env.WCL_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body
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
