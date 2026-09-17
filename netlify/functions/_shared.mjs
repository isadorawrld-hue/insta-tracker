// ============================================
// _shared.mjs — logique commune aux fonctions
// ============================================

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SC_KEY = process.env.SCRAPECREATORS_API_KEY;

// ---------- Client Supabase minimal (REST, aucune dépendance) ----------
async function sb(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${t.slice(0, 300)}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

export async function sbSelect(path) {
  return sb(path, { headers: { Prefer: "return=representation" } });
}
export async function sbUpsert(table, rows, onConflict) {
  const q = onConflict ? `${table}?on_conflict=${onConflict}` : table;
  return sb(q, { method: "POST", body: rows });
}
export async function sbUpdate(table, filter, patch) {
  return sb(`${table}?${filter}`, { method: "PATCH", body: patch });
}
export async function sbInsert(table, rows) {
  return sb(table, { method: "POST", body: rows, headers: { Prefer: "return=minimal" } });
}

// ---------- Helpers ----------
const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

// Cherche en profondeur la première valeur numérique portée par une des clés
function deepFindNumber(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  for (const k of keys) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v === "object" && v !== null && "count" in v) {
        const n = num(v.count);
        if (n !== null) return n;
      }
      const n = num(v);
      if (n !== null) return n;
    }
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v !== null) {
      const r = deepFindNumber(v, keys, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

// Cherche en profondeur le premier tableau de posts plausible
function deepFindPosts(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  const candidates = ["edges", "items", "posts", "recent_posts", "medias"];
  for (const k of candidates) {
    const v = obj[k];
    if (Array.isArray(v) && v.length) {
      const first = v[0]?.node || v[0];
      if (first && typeof first === "object" &&
          ("taken_at_timestamp" in first || "taken_at" in first || "like_count" in first ||
           "video_view_count" in first || "play_count" in first || "shortcode" in first || "code" in first)) {
        return v;
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v !== null) {
      const r = deepFindPosts(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ---------- Parsing défensif de la réponse Scrape Creators ----------
// La réponse suit le format web Instagram (data.user.…) mais on reste
// tolérant : chemins connus d'abord, scan en profondeur en secours,
// et le JSON brut est stocké dans snapshots.raw quoi qu'il arrive.
export function extractProfile(json) {
  const u = json?.data?.user || json?.user || json?.data || json || {};

  let followers =
    num(u?.edge_followed_by?.count) ?? num(u?.follower_count) ?? num(u?.followers);
  let following =
    num(u?.edge_follow?.count) ?? num(u?.following_count) ?? num(u?.follows);
  let postsCount =
    num(u?.edge_owner_to_timeline_media?.count) ?? num(u?.media_count) ?? num(u?.posts_count);

  if (followers === null) followers = deepFindNumber(json, ["edge_followed_by", "follower_count", "followers_count", "followers"]);
  if (following === null) following = deepFindNumber(json, ["edge_follow", "following_count"]);
  if (postsCount === null) postsCount = deepFindNumber(json, ["edge_owner_to_timeline_media", "media_count", "posts_count"]);

  let rawPosts =
    u?.edge_owner_to_timeline_media?.edges ||
    (Array.isArray(u?.recent_posts) ? u.recent_posts : null) ||
    (Array.isArray(u?.items) ? u.items : null) ||
    deepFindPosts(json) || [];

  const posts = [];
  for (const e of rawPosts) {
    const n0 = e?.node || e;
    if (!n0 || typeof n0 !== "object") continue;
    let ts = num(n0.taken_at_timestamp) ?? num(n0.taken_at);
    if (ts === null && typeof n0.timestamp === "string") {
      const p = Date.parse(n0.timestamp);
      if (Number.isFinite(p)) ts = Math.floor(p / 1000);
    }
    const views =
      num(n0.video_view_count) ?? num(n0.play_count) ?? num(n0.video_play_count) ?? num(n0.view_count);
    const likes =
      num(n0.edge_liked_by?.count) ?? num(n0.edge_media_preview_like?.count) ?? num(n0.like_count) ?? 0;
    const comments =
      num(n0.edge_media_to_comment?.count) ?? num(n0.comment_count) ?? 0;
    posts.push({ ts, views, likes, comments });
  }

  return { followers, following, postsCount, posts };
}

// Agrégats sur 30 jours à partir des posts visibles du profil
export function aggregate30d(posts) {
  const cutoff = Date.now() / 1000 - 30 * 86400;
  let views = 0, reels = 0, likes = 0, comments = 0, hasViews = false;
  for (const p of posts) {
    if (p.ts === null || p.ts < cutoff) continue;
    reels += 1;
    likes += p.likes || 0;
    comments += p.comments || 0;
    if (p.views !== null && p.views !== undefined) {
      views += p.views;
      hasViews = true;
    }
  }
  return { views_30d: hasViews ? views : null, reels_30d: reels, likes_30d: likes, comments_30d: comments };
}

// ---------- Appel Scrape Creators : profil ----------
export async function fetchInstagramProfile(handle) {
  const url = `https://api.scrapecreators.com/v1/instagram/profile?handle=${encodeURIComponent(handle)}`;
  const res = await fetch(url, { headers: { "x-api-key": SC_KEY } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* réponse non-JSON */ }

  const bodyLower = (text || "").slice(0, 2000).toLowerCase();

  // Instagram masque certains profils aux visiteurs non connectés.
  // L'API répond alors "Profile is restricted" : le compte existe,
  // mais ses statistiques sont illisibles de l'extérieur.
  const restricted = /profile is restricted|restricted/i.test(
    String(json?.message || "") + " " + String(json?.error || "")
  );

  // "Introuvable" : signaux clairs, et seulement si non restreint
  const notFound =
    !restricted && (
      res.status === 404 ||
      json?.success === false ||
      /not\s*found|does\s*not\s*exist|no\s*user|user\s*not/i.test(bodyLower)
    );

  return { ok: res.ok, status: res.status, json, notFound, restricted };
}

// ---------- Appel Scrape Creators : reels (c'est ici que sont les VUES) ----------
// L'endpoint /profile ne renvoie pas les compteurs de lectures : il faut
// cet endpoint dédié. Il pagine via max_id — sans ça on ne récupère que la
// première page (~12 reels), ce qui sous-estime les fenêtres 15 et 30 jours.
// On passe le user_id quand on l'a (réponse plus rapide).

// Cherche l'identifiant de page suivante, quel que soit son emplacement
function findMaxId(json) {
  if (!json || typeof json !== "object") return null;
  const direct =
    json.max_id ?? json.next_max_id ??
    json.paging_info?.max_id ?? json.paging_info?.next_max_id ??
    json.data?.max_id ?? json.data?.next_max_id;
  if (direct) return String(direct);
  const more = json.more_available ?? json.paging_info?.more_available;
  if (more === false) return null;
  // recherche en profondeur en dernier recours
  const seek = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 5) return null;
    for (const k of ["next_max_id", "max_id"]) {
      if (o[k] && typeof o[k] !== "object") return String(o[k]);
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") { const r = seek(v, depth + 1); if (r) return r; }
    }
    return null;
  };
  return seek(json);
}

function itemsOf(json) {
  return (Array.isArray(json?.items) && json.items) ||
         (Array.isArray(json?.data?.items) && json.data.items) ||
         (Array.isArray(json?.reels) && json.reels) ||
         deepFindPosts(json) || [];
}

// Date (unix) d'un item, quelle que soit la forme de la réponse
function itemTs(raw) {
  const m = raw?.media || raw?.node || raw || {};
  let ts = num(m.taken_at) ?? num(raw?.taken_at) ?? num(m.taken_at_timestamp);
  if (ts === null) {
    const iso = m.created_at || raw?.created_at;
    if (typeof iso === "string") {
      const p = Date.parse(iso);
      if (Number.isFinite(p)) ts = Math.floor(p / 1000);
    }
  }
  return ts;
}

export async function fetchInstagramReels(handle, userId) {
  const base = "https://api.scrapecreators.com/v1/instagram/user/reels";
  const idPart = userId
    ? `user_id=${encodeURIComponent(userId)}`
    : `handle=${encodeURIComponent(handle)}`;

  const cutoff = Date.now() / 1000 - 35 * 86400; // marge au-delà des 30 j
  const MAX_PAGES = 10;                           // couvre 30 j même à 3 reels/jour
  const all = [];
  let maxId = null;
  let pages = 0;
  let ok = false;
  let firstJson = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const url = `${base}?${idPart}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
    let json = null;
    try {
      const res = await fetch(url, { headers: { "x-api-key": SC_KEY } });
      const text = await res.text();
      try { json = JSON.parse(text); } catch { /* ignore */ }
      if (!res.ok) break;
    } catch { break; }

    if (!json) break;
    ok = true;
    pages += 1;
    if (!firstJson) firstJson = json;

    const items = itemsOf(json);
    if (items.length === 0) break;
    all.push(...items);

    // a-t-on dépassé la fenêtre utile ?
    const oldest = items.reduce((min, it) => {
      const t = itemTs(it);
      return (t !== null && (min === null || t < min)) ? t : min;
    }, null);
    if (oldest !== null && oldest < cutoff) break;

    const next = findMaxId(json);
    if (!next || next === maxId) break;
    maxId = next;

    await new Promise((r) => setTimeout(r, 150)); // on n'enchaîne pas trop vite
  }

  return {
    ok,
    pages,
    json: ok ? { items: all, _pages: pages, _sample: firstJson?.paging_info || null } : null,
  };
}

// Extrait l'id utilisateur de la réponse profil (pour accélérer l'appel reels)
export function extractUserId(json) {
  const u = json?.data?.user || json?.user || json?.data || json || {};
  const id = u?.id ?? u?.pk ?? u?.user_id ?? deepFindNumber(json, ["pk", "user_id"]);
  return id != null ? String(id) : null;
}

// ---------- Parsing des reels + agrégats multi-périodes ----------
// Fenêtres : 7 j, 15 j, 30 j et total (tous les reels renvoyés par l'API).
export function aggregateReels(reelsJson) {
  const items =
    (Array.isArray(reelsJson?.items) && reelsJson.items) ||
    (Array.isArray(reelsJson?.data?.items) && reelsJson.data.items) ||
    (Array.isArray(reelsJson?.reels) && reelsJson.reels) ||
    deepFindPosts(reelsJson) ||
    [];

  const nowSec = Date.now() / 1000;
  const W = { d7: 7, d15: 15, d30: 30 };
  const mk = () => ({ views: 0, reels: 0, likes: 0, comments: 0, hasViews: false });
  const acc = { d7: mk(), d15: mk(), d30: mk(), total: mk() };

  let lastViews = null, lastTs = null;

  for (const raw of items) {
    const m = raw?.media || raw?.node || raw || {};

    let ts = num(m.taken_at) ?? num(raw?.taken_at) ?? num(m.taken_at_timestamp);
    if (ts === null) {
      const iso = m.created_at || raw?.created_at;
      if (typeof iso === "string") {
        const p = Date.parse(iso);
        if (Number.isFinite(p)) ts = Math.floor(p / 1000);
      }
    }

    const v =
      num(m.play_count) ?? num(m.ig_play_count) ?? num(m.view_count) ??
      num(m.video_view_count) ?? num(raw?.play_count) ?? num(raw?.ig_play_count) ??
      num(raw?.view_count);
    const l = num(m.like_count) ?? num(m.edge_liked_by?.count) ?? num(raw?.like_count) ?? 0;
    const c = num(m.comment_count) ?? num(m.edge_media_to_comment?.count) ?? num(raw?.comment_count) ?? 0;

    if (v !== null && (lastTs === null || (ts !== null && ts > lastTs))) {
      lastTs = ts; lastViews = v;
    }

    const add = (bucket) => {
      bucket.reels += 1;
      bucket.likes += l;
      bucket.comments += c;
      if (v !== null) { bucket.views += v; bucket.hasViews = true; }
    };

    // le total compte tout, même sans date exploitable
    add(acc.total);

    if (ts === null) continue;
    const ageDays = (nowSec - ts) / 86400;
    if (ageDays <= W.d7) add(acc.d7);
    if (ageDays <= W.d15) add(acc.d15);
    if (ageDays <= W.d30) add(acc.d30);
  }

  const out = (b) => ({
    views: b.hasViews ? b.views : null,
    reels: b.reels,
    likes: b.likes,
    comments: b.comments,
  });

  return {
    d7: out(acc.d7),
    d15: out(acc.d15),
    d30: out(acc.d30),
    total: out(acc.total),
    last_reel_views: lastViews,
    items_seen: items.length,
  };
}

// ---------- Telegram (optionnel) ----------
export async function telegramSend(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch { /* jamais bloquant */ }
}

// ---------- Le scan complet ----------
export async function runScan() {
  const today = new Date().toISOString().slice(0, 10);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

  // Comptes à scanner : actifs + introuvables depuis moins de 3 jours (auto-récupération)
  const accounts = await sbSelect(
    `accounts?select=id,username,status,status_changed_on&active=eq.true&order=username.asc`
  );
  const toScan = (accounts || []).filter(
    (a) =>
      a.status === "actif" ||
      a.status === "restreint" ||
      (a.status === "introuvable" && (a.status_changed_on || today) >= threeDaysAgo)
  );

  let errors = 0;
  const nowGone = [];
  const recovered = [];
  const restricted = [];

  // Par vagues de 5 pour rester rapide sans bourriner
  for (let i = 0; i < toScan.length; i += 5) {
    const batch = toScan.slice(i, i + 5);
    await Promise.all(
      batch.map(async (acc) => {
        try {
          const r = await fetchInstagramProfile(acc.username);

          if (r.restricted) {
            if (acc.status !== "restreint") {
              await sbUpdate("accounts", `id=eq.${acc.id}`, {
                status: "restreint",
                status_changed_on: today,
              });
            }
            restricted.push(acc.username);
            return;
          }

          if (r.notFound) {
            if (acc.status === "actif") {
              await sbUpdate("accounts", `id=eq.${acc.id}`, {
                status: "introuvable",
                status_changed_on: today,
              });
              nowGone.push(acc.username);
            }
            return;
          }

          if (!r.ok || !r.json) { errors += 1; return; }

          const prof = extractProfile(r.json);
          const aggProfile = aggregate30d(prof.posts);

          // Les vues ne sont PAS dans /profile : on interroge l'endpoint reels
          const userId = extractUserId(r.json);
          const rl = await fetchInstagramReels(acc.username, userId);
          const ag = rl.ok && rl.json ? aggregateReels(rl.json) : null;
          const useReels = !!(ag && ag.items_seen > 0);

          await sbUpsert(
            "snapshots",
            [{
              account_id: acc.id,
              taken_on: today,
              followers: prof.followers,
              following: prof.following,
              posts_count: prof.postsCount,

              views_7d:     useReels ? ag.d7.views    : null,
              reels_7d:     useReels ? ag.d7.reels    : null,
              likes_7d:     useReels ? ag.d7.likes    : null,
              comments_7d:  useReels ? ag.d7.comments : null,

              views_15d:    useReels ? ag.d15.views    : null,
              reels_15d:    useReels ? ag.d15.reels    : null,
              likes_15d:    useReels ? ag.d15.likes    : null,
              comments_15d: useReels ? ag.d15.comments : null,

              views_30d:    useReels ? ag.d30.views    : aggProfile.views_30d,
              reels_30d:    useReels ? ag.d30.reels    : aggProfile.reels_30d,
              likes_30d:    useReels ? ag.d30.likes    : aggProfile.likes_30d,
              comments_30d: useReels ? ag.d30.comments : aggProfile.comments_30d,

              views_total:    useReels ? ag.total.views    : null,
              reels_total:    useReels ? ag.total.reels    : null,
              likes_total:    useReels ? ag.total.likes    : null,
              comments_total: useReels ? ag.total.comments : null,

              raw: { profile: r.json, reels: rl.json || null },
            }],
            "account_id,taken_on"
          );

          if (acc.status === "introuvable" || acc.status === "restreint") {
            await sbUpdate("accounts", `id=eq.${acc.id}`, {
              status: "actif",
              status_changed_on: today,
            });
            recovered.push(acc.username);
          }
        } catch (e) {
          errors += 1;
          console.error(`Scan ${acc.username}:`, e.message);
        }
      })
    );
    if (i + 5 < toScan.length) await new Promise((r) => setTimeout(r, 400));
  }

  // Clics des liens LinkScale, dans la foulée
  let ls = null;
  try { ls = await syncLinkScale(); } catch (e) { ls = { error: e.message }; }

  await sbInsert("scan_log", [{
    accounts_scanned: toScan.length,
    errors,
    details: JSON.stringify({ introuvables: nowGone, restreints: restricted, retrouves: recovered, linkscale: ls }).slice(0, 500),
  }]);

  // Notification Telegram (si configurée)
  let msg = `📊 <b>Tracker Insta — scan terminé</b>\n${toScan.length} comptes relevés, ${errors} erreur(s).`;
  if (nowGone.length) msg += `\n⚠️ Introuvables : ${nowGone.join(", ")}`;
  if (restricted.length) msg += `\n🔒 Restreints par Instagram : ${restricted.join(", ")}`;
  if (recovered.length) msg += `\n✅ De retour : ${recovered.join(", ")}`;
  await telegramSend(msg);

  return { scanned: toScan.length, errors, nowGone, recovered };
}

// ---------- Sécurité inter-fonctions ----------
export function checkInternalKey(req) {
  return req.headers.get("x-internal-key") === SB_KEY;
}

export async function getSettings() {
  const rows = await sbSelect("app_settings?select=data&id=eq.1");
  return rows?.[0]?.data || {};
}

/* ============================================================
   LINKSCALE — clics des liens, via leur point d'entrée MCP
   ============================================================ */
const LS_URL = "https://dashboard.linkscale.to/api/mcp";

async function lsCall(method, params) {
  const res = await fetch(LS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINKSCALE_API_KEY || ""}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} }),
  });
  const text = await res.text();
  let payload = text;
  if (text.includes("data:")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (line) payload = line.slice(5).trim();
  }
  try { return JSON.parse(payload); } catch { return null; }
}

// Un appel d'outil MCP : le résultat utile est du JSON encodé en texte
async function lsTool(name, args) {
  const r = await lsCall("tools/call", { name, arguments: args || {} });
  const blocks = r?.result?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      try { return JSON.parse(b.text); } catch { return { text: b.text }; }
    }
  }
  return null;
}

// La réponse utile est dans stats.summary :
//   totalClicks = trafic total, uniqueUsers = visiteurs uniques,
//   bots / spam = trafic filtré.
function summaryOf(r) {
  const sum = r?.stats?.summary || r?.summary || r?.data?.stats?.summary || null;
  if (!sum) return null;
  const n = (x) => (typeof x === "number" ? x : (typeof x === "string" && /^\d+$/.test(x) ? Number(x) : null));
  return {
    visits: n(sum.totalClicks) ?? n(sum.total_clicks) ?? n(sum.visits),
    uniques: n(sum.uniqueUsers) ?? n(sum.unique_users) ?? n(sum.uniqueUsersNormal),
    humans: n(sum.uniqueUsersNormal),
    bots: n(sum.bots),
    spam: n(sum.spam),
  };
}

const isoAt = (d) => new Date(Date.now() - d * 86400000).toISOString();

// Une fenêtre. Au-delà d'une dizaine de jours la réponse dépasse la limite
// de transport MCP (9 000 caractères) et LinkScale la tronque : on découpe
// alors en tranches courtes et on additionne.
async function statsRange(linkId, fromDays, toDays) {
  const r = await lsTool("get_link_stats", {
    link_id: linkId,
    from: isoAt(fromDays),
    to: toDays === 0 ? new Date().toISOString() : isoAt(toDays),
  });
  const truncated = !!(r && r.truncated_for_transport);
  return { sum: summaryOf(r), truncated, raw: r };
}

async function statsWindow(linkId, days) {
  // tentative directe
  const direct = await statsRange(linkId, days, 0);
  if (direct.sum && !direct.truncated) {
    return { ...direct.sum, chunks: 1, raw: direct.raw };
  }
  // découpage en tranches de 6 jours
  const step = 6;
  let visits = 0, humans = 0, bots = 0, got = false, chunks = 0;
  for (let from = days; from > 0; from -= step) {
    const to = Math.max(0, from - step);
    const part = await statsRange(linkId, from, to);
    chunks += 1;
    if (part.sum) {
      if (part.sum.visits != null) { visits += part.sum.visits; got = true; }
      if (part.sum.humans != null) humans += part.sum.humans;
      if (part.sum.bots != null) bots += part.sum.bots;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return got
    // les visiteurs uniques ne s'additionnent pas entre tranches : on ne les invente pas
    ? { visits, uniques: null, humans, bots, chunks, raw: { chunked: true, chunks } }
    : { visits: null, uniques: null, humans: null, bots: null, chunks, raw: direct.raw };
}

// Tout vient des logs de visites : chaque ligne porte le pays de la visite
// et la liste des clics effectués dessus. Une seule source, donc des chiffres
// cohérents entre eux (vues, clics et pays partagent le même dénominateur).
async function visitLogs(linkId, days, maxPages = 12) {
  const from = isoAt(days);
  const to = new Date().toISOString();
  const rows = [];
  let cursor = null, lastId = null, truncated = false;

  for (let p = 0; p < maxPages; p++) {
    const args = { link_id: linkId, source: "visits", from, to, limit: 100, visitor_type: "humans" };
    if (cursor) args.next_cursor = cursor;
    if (lastId) args.last_id = lastId;

    const r = await lsTool("get_link_logs", args);
    const page = Array.isArray(r?.data) ? r.data
      : Array.isArray(r?.logs) ? r.logs
      : Array.isArray(r?.entries) ? r.entries
      : Array.isArray(r) ? r : [];
    if (page.length === 0) break;
    rows.push(...page);

    const more = r?.has_more === true;
    const np = r?.next_page || {};
    const nc = np.next_cursor || r?.next_cursor || null;
    const li = np.last_id || r?.last_id || null;
    if (!more || !nc || nc === cursor) break;
    cursor = nc; lastId = li;

    if (p === maxPages - 1) truncated = true;
    await new Promise((x) => setTimeout(x, 90));
  }
  return { rows, truncated };
}

// Les logs de clics portent clicked_url : on en déduit la destination.
async function clickLogs(linkId, days, maxPages = 12) {
  const from = isoAt(days);
  const to = new Date().toISOString();
  const rows = [];
  let cursor = null, lastId = null;

  for (let p = 0; p < maxPages; p++) {
    const args = { link_id: linkId, source: "clicks", from, to, limit: 100 };
    if (cursor) args.next_cursor = cursor;
    if (lastId) args.last_id = lastId;

    const r = await lsTool("get_link_logs", args);
    const page = Array.isArray(r?.data) ? r.data : [];
    if (page.length === 0) break;
    rows.push(...page);

    const more = r?.has_more === true;
    const np = r?.next_page || {};
    const nc = np.next_cursor || r?.next_cursor || null;
    if (!more || !nc || nc === cursor) break;
    cursor = nc; lastId = np.last_id || r?.last_id || null;
    await new Promise((x) => setTimeout(x, 90));
  }
  return rows;
}

// Reconnaître la destination à partir de l'URL cliquée
function destinationOf(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return { key: "autre", label: "Autre" };
  if (/(^|\/\/|\.)(t|telegram)\.me\b|telegram\.org|\bt\.me\b/.test(u))
    return { key: "telegram", label: "Telegram" };
  if (/mym\.fans|mym\.social|\bmym\b/.test(u)) return { key: "mym", label: "MYM" };
  if (/onlyfans\.com|\bof\.\w/.test(u)) return { key: "onlyfans", label: "OnlyFans" };
  if (/instagram\.com/.test(u)) return { key: "instagram", label: "Instagram" };
  if (/snapchat\.com/.test(u)) return { key: "snapchat", label: "Snapchat" };
  if (/tiktok\.com/.test(u)) return { key: "tiktok", label: "TikTok" };
  if (/whatsapp\.com|wa\.me/.test(u)) return { key: "whatsapp", label: "WhatsApp" };
  try {
    const host = new URL(u).hostname.replace(/^www\./, "");
    return { key: "autre", label: host };
  } catch { return { key: "autre", label: "Autre" }; }
}

// Regroupe les clics par destination, en comptant aussi les personnes
function destinations(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r?.spam === 1 || r?.blocked === 1 || r?.bot === true) continue;
    const d = destinationOf(r.clicked_url);
    const visiteur = r.stats_id || r.stats_mongo_id || r.mongo_id || r._id;
    if (!map.has(d.key)) map.set(d.key, { key: d.key, label: d.label, clicks: 0, people: new Set() });
    const e = map.get(d.key);
    e.clicks += 1;
    if (visiteur) e.people.add(String(visiteur));
    // un libellé plus précis l'emporte sur "Autre"
    if (e.label === "Autre" && d.label !== "Autre") e.label = d.label;
  }
  return [...map.values()]
    .map((e) => ({ key: e.key, label: e.label, clicks: e.clicks, people: e.people.size }))
    .sort((a, b) => b.people - a.people || b.clicks - a.clicks);
}

// Vues, clics et pays, calculés en une passe sur les mêmes visites
function digest(rows) {
  let visits = 0, clicks = 0, convertis = 0;
  const tally = new Map();
  for (const r of rows) {
    if (r?.spam === 1 || r?.blocked === 1) continue; // trafic filtré
    visits += 1;

    const cl = Array.isArray(r.clicks) ? r.clicks.length : 0;
    clicks += cl;
    if (cl > 0) convertis += 1;

    const c = String(r.country || "").toUpperCase().trim();
    if (c && c.length <= 3) tally.set(c, (tally.get(c) || 0) + 1);
  }
  const pays = [...tally.entries()]
    .map(([country, v]) => ({ country, visits: v }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 15);
  return { visits, clicks, convertis, pays };
}

export async function syncLinkScale() {
  if (!process.env.LINKSCALE_API_KEY) return { skipped: "clé absente" };
  const today = new Date().toISOString().slice(0, 10);

  // 1. Les dossiers LinkScale. On part d'eux : un lien sans dossier
  //    n'est pas suivi, et le nom du dossier fait foi.
  const fRes = await lsTool("list_folders", {});
  const folders =
    fRes?.folders || fRes?.data || (Array.isArray(fRes) ? fRes : []) || [];
  if (folders.length === 0) {
    return { links: 0, note: "aucun dossier LinkScale — rien à suivre" };
  }

  // 2. Pour chaque dossier, ses liens (et seulement ceux-là)
  const rows = [];
  for (const f of folders) {
    const fid = String(f._id || f.id || "");
    const fname = (f.name || "").trim();
    if (!fid || !fname) continue;

    let offset = 0;
    for (let p = 0; p < 5; p++) {
      const r = await lsTool("list_links", { folder_id: fid, limit: 100, offset });
      const page = r?.links || [];
      for (const l of page) {
        rows.push({
          link_id: String(l._id || l.id),
          slug: l.u || l.slug || null,
          domain: l.domain || null,
          url: l.url || null,
          folder_name: fname,
          // l_p = page d'atterrissage (des boutons à cliquer)
          // d_l = lien direct (redirection immédiate, pas de bouton)
          kind: l.type === "d_l" ? "direct" : "landing",
          enabled: l.enabled !== false,
          active: true,
        });
      }
      const returned = r?.pagination?.returned ?? page.length;
      if (!r?.pagination?.has_more || returned === 0) break;
      offset += returned;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  if (rows.length === 0) {
    return { links: 0, note: "dossiers vides" };
  }

  await sbUpsert("links", rows, "link_id");

  // 3. Les liens qui ne sont plus dans un dossier sortent du suivi
  const known = new Set(rows.map((r) => r.link_id));
  const existing = (await sbSelect("links?select=link_id&active=eq.true")) || [];
  for (const e of existing) {
    if (!known.has(e.link_id)) {
      await sbUpdate("links", `link_id=eq.${encodeURIComponent(e.link_id)}`, { active: false });
    }
  }

  // 4. Rattachement à une VA quand le dossier porte son prénom
  const vas = (await sbSelect("vas?select=name&active=eq.true")) || [];
  const byLower = new Map(vas.map((v) => [String(v.name).toLowerCase(), v.name]));
  for (const r of rows) {
    const guess = byLower.get(r.folder_name.toLowerCase());
    if (guess) {
      await sbUpdate("links", `link_id=eq.${encodeURIComponent(r.link_id)}`, { va_name: guess });
    }
  }

  // 5. Relevé : tout depuis les logs, une seule source
  const actifs = (await sbSelect("links?select=link_id&active=eq.true&enabled=eq.true")) || [];
  let done = 0, errors = 0;
  for (const l of actifs.slice(0, 120)) {
    try {
      const l7 = await visitLogs(l.link_id, 7, 6);
      const l30 = await visitLogs(l.link_id, 30, 12);
      const d7 = digest(l7.rows);
      const d30 = digest(l30.rows);

      await sbUpsert("link_stats", [{
        link_id: l.link_id, taken_on: today,
        visits_7d: d7.visits, visits_30d: d30.visits,
        // "uniques" porte ici le nombre de visiteurs ayant cliqué au moins une fois
        uniques_7d: d7.convertis, uniques_30d: d30.convertis,
        clicks_7d: d7.clicks, clicks_30d: d30.clicks,
        sampled: l30.truncated,
        raw: { pages7: l7.rows.length, pages30: l30.rows.length, tronque: l30.truncated },
      }], "link_id,taken_on");

      // destinations des clics, sur les deux fenêtres
      for (const [days, maxP] of [[7, 6], [30, 12]]) {
        const cl = await clickLogs(l.link_id, days, maxP);
        const dest = destinations(cl);
        if (dest.length) {
          await sbUpsert("link_destinations",
            dest.map((d) => ({
              link_id: l.link_id, taken_on: today, window_days: days,
              destination: d.key, label: d.label, clicks: d.clicks, people: d.people,
            })), "link_id,taken_on,window_days,destination");
        }
      }

      if (d30.pays.length) {
        await sbUpsert("link_countries",
          d30.pays.map((c) => ({ link_id: l.link_id, taken_on: today, country: c.country, visits: c.visits })),
          "link_id,taken_on,country");
      }

      done += 1;
      await new Promise((r) => setTimeout(r, 110));
    } catch (e) { errors += 1; console.error("LinkScale", l.link_id, e.message); }
  }
  return { dossiers: folders.length, links: rows.length, releves: done, errors };
}
