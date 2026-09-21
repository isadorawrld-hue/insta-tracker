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

// ---------- Secours : endpoint POSTS (v2) ----------
// Les comptes récents sont souvent renvoyés sans aucun reel par
// /user/reels (Instagram ne les marque pas encore "has_clips").
// L'endpoint /v2/instagram/user/posts, lui, renvoie bien leurs vidéos
// avec play_count. On ne s'en sert QUE si l'appel reels est revenu vide.
function isVideoItem(raw) {
  const m = raw?.media || raw?.node || raw || {};
  if (m.media_type === 2 || raw?.media_type === 2) return true;
  const pt = String(m.product_type || raw?.product_type || "").toLowerCase();
  if (pt === "clips" || pt === "igtv" || pt === "reels") return true;
  return num(m.play_count) !== null || num(m.ig_play_count) !== null ||
         num(raw?.play_count) !== null || num(raw?.ig_play_count) !== null;
}

export async function fetchInstagramPosts(handle) {
  const base = "https://api.scrapecreators.com/v2/instagram/user/posts";
  const cutoff = Date.now() / 1000 - 35 * 86400;
  const MAX_PAGES = 6;
  const all = [];
  let nextMaxId = null;
  let ok = false;
  let pages = 0;

  for (let i = 0; i < MAX_PAGES; i++) {
    const url = `${base}?handle=${encodeURIComponent(handle)}` +
      (nextMaxId ? `&next_max_id=${encodeURIComponent(nextMaxId)}` : "");
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

    const items = (Array.isArray(json.items) && json.items) ||
                  (Array.isArray(json?.data?.items) && json.data.items) || [];
    if (items.length === 0) break;
    all.push(...items.filter(isVideoItem));

    const oldest = items.reduce((min, it) => {
      const t = itemTs(it);
      return (t !== null && (min === null || t < min)) ? t : min;
    }, null);
    if (oldest !== null && oldest < cutoff) break;

    const next = json.next_max_id ?? json?.data?.next_max_id ?? null;
    const more = json.more_available ?? json?.data?.more_available;
    if (more === false || !next || String(next) === String(nextMaxId)) break;
    nextMaxId = String(next);

    await new Promise((r) => setTimeout(r, 150));
  }

  return { ok, pages, json: ok ? { items: all, _pages: pages, _source: "posts" } : null };
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
          let src = rl;
          let ag = rl.ok && rl.json ? aggregateReels(rl.json) : null;

          // Rien côté /user/reels (typique des comptes récents) :
          // on retente avec l'endpoint posts, qui porte aussi les vues.
          if (!ag || ag.items_seen === 0) {
            const po = await fetchInstagramPosts(acc.username);
            const agp = po.ok && po.json ? aggregateReels(po.json) : null;
            if (agp && agp.items_seen > 0) { ag = agp; src = po; }
          }
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

              raw: { profile: r.json, reels: src.json || null },
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

/* ---------- Relevé par lien : les outils "résumé" de LinkScale ----------
   get_link_stats renvoie toutes ses listes et dépasse systématiquement la
   limite de 9 000 caractères du transport MCP : la réponse revient alors
   vidée de ses totaux. Et parcourir les logs page par page est illusoire —
   LinkScale les sert par toutes petites pages, on s'arrêtait à ~60 visites
   sur des milliers. On utilise donc les outils prévus pour ça, qui répondent
   en un appel et restent sous la limite :
     summarize_link_performance → visites, clics, pays, boutons
     get_ctr_report (unique_clicks) → nombre de personnes ayant cliqué     */

function summarize(r) {
  const a = r?.analytics || {};
  const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  if (!r || (a.visits == null && a.total_button_clicks == null)) return null;
  return {
    visits: n(a.visits),
    bots: n(a.bots),
    humans: n(a.unique_visitors_human) ?? n(a.unique_visitors),
    clicks: n(a.total_button_clicks),
    buttons: Array.isArray(r.top_buttons) ? r.top_buttons : [],
    countries: Array.isArray(r.top_countries) ? r.top_countries : [],
  };
}

async function linkSummary(linkId, days) {
  return summarize(await lsTool("summarize_link_performance", { link_id: linkId, days }));
}

// Personnes ayant cliqué + taux de clic, calcul du tableau de bord.
// Les liens directs n'ont pas de page, donc pas de CTR : l'outil les exclut.
async function linkCtr(linkId, days) {
  const r = await lsTool("get_ctr_report", {
    link_id: linkId, days, ctr_mode: "unique_clicks", min_visitors: 0, limit: 5,
  });
  const row = (Array.isArray(r?.links) ? r.links : []).find((x) => x?.link_id === linkId)
    || (Array.isArray(r?.links) && r.links.length === 1 ? r.links[0] : null)
    || r?.project || null;
  if (!row) return { clickers: null, ctr: null };
  const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    clickers: n(row.unique_clickers),
    ctr: n(row.ctr_pct) ?? n(row.weighted_avg_ctr_pct),
  };
}

// Les boutons portent leur URL : on regroupe par destination (Telegram, MYM…)
function destinationsFromButtons(buttons) {
  const map = new Map();
  for (const b of buttons || []) {
    const clicks = Number(b?.clicks);
    if (!Number.isFinite(clicks)) continue;
    const d = destinationOf(b.url);
    if (!map.has(d.key)) map.set(d.key, { key: d.key, label: d.label, clicks: 0 });
    const e = map.get(d.key);
    e.clicks += clicks;
    if (e.label === "Autre" && d.label !== "Autre") e.label = d.label;
  }
  return [...map.values()].sort((a, b) => b.clicks - a.clicks);
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

  // 5. Relevé par lien, via les outils de résumé (aucun parcours de logs)
  const actifs = (await sbSelect("links?select=link_id,kind&active=eq.true&enabled=eq.true")) || [];
  let done = 0, errors = 0, vides = 0;
  for (const l of actifs.slice(0, 120)) {
    try {
      const s7 = await linkSummary(l.link_id, 7);
      const s30 = await linkSummary(l.link_id, 30);
      if (!s7 && !s30) { vides += 1; continue; }

      // un lien direct redirige sans page : pas de bouton, donc pas de CTR
      const direct = l.kind === "direct";
      const c7 = direct ? { clickers: null, ctr: null } : await linkCtr(l.link_id, 7);
      const c30 = direct ? { clickers: null, ctr: null } : await linkCtr(l.link_id, 30);

      await sbUpsert("link_stats", [{
        link_id: l.link_id, taken_on: today,
        visits_7d: s7?.visits ?? null, visits_30d: s30?.visits ?? null,
        // "uniques" porte le nombre de personnes ayant cliqué au moins une fois
        uniques_7d: c7.clickers, uniques_30d: c30.clickers,
        clicks_7d: s7?.clicks ?? null, clicks_30d: s30?.clicks ?? null,
        sampled: false,   // plus d'échantillon : ce sont les totaux de LinkScale
        raw: {
          source: "summarize_link_performance + get_ctr_report",
          bots_7d: s7?.bots ?? null, bots_30d: s30?.bots ?? null,
          humains_7d: s7?.humans ?? null, humains_30d: s30?.humans ?? null,
          ctr_7d: c7.ctr, ctr_30d: c30.ctr,
        },
      }], "link_id,taken_on");

      // destinations des clics, par fenêtre
      for (const [days, sum] of [[7, s7], [30, s30]]) {
        const dest = destinationsFromButtons(sum?.buttons);
        if (dest.length) {
          await sbUpsert("link_destinations",
            dest.map((d) => ({
              link_id: l.link_id, taken_on: today, window_days: days,
              destination: d.key, label: d.label, clicks: d.clicks,
              // LinkScale donne les clics par bouton, pas le nombre de personnes
              people: null,
            })), "link_id,taken_on,window_days,destination");
        }
      }

      const pays = (s30?.countries || []).filter((c) => c?.country && Number.isFinite(Number(c.visits)));
      if (pays.length) {
        await sbUpsert("link_countries",
          pays.map((c) => ({
            link_id: l.link_id, taken_on: today,
            country: String(c.country).toUpperCase().slice(0, 3), visits: Number(c.visits),
          })),
          "link_id,taken_on,country");
      }

      done += 1;
      await new Promise((r) => setTimeout(r, 110));
    } catch (e) { errors += 1; console.error("LinkScale", l.link_id, e.message); }
  }
  return { dossiers: folders.length, links: rows.length, releves: done, vides, errors };
}
