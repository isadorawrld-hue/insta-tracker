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

// ---------- Appel Scrape Creators ----------
export async function fetchInstagramProfile(handle) {
  const url = `https://api.scrapecreators.com/v1/instagram/profile?handle=${encodeURIComponent(handle)}`;
  const res = await fetch(url, { headers: { "x-api-key": SC_KEY } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* réponse non-JSON */ }

  // Détection "compte introuvable" — uniquement sur signaux clairs
  const bodyLower = (text || "").slice(0, 2000).toLowerCase();
  const notFound =
    res.status === 404 ||
    json?.success === false ||
    /not\s*found|does\s*not\s*exist|no\s*user|user\s*not/i.test(bodyLower);

  return { ok: res.ok, status: res.status, json, notFound };
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
      (a.status === "introuvable" && (a.status_changed_on || today) >= threeDaysAgo)
  );

  let errors = 0;
  const nowGone = [];
  const recovered = [];

  // Par vagues de 5 pour rester rapide sans bourriner
  for (let i = 0; i < toScan.length; i += 5) {
    const batch = toScan.slice(i, i + 5);
    await Promise.all(
      batch.map(async (acc) => {
        try {
          const r = await fetchInstagramProfile(acc.username);

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
          const agg = aggregate30d(prof.posts);

          await sbUpsert(
            "snapshots",
            [{
              account_id: acc.id,
              taken_on: today,
              followers: prof.followers,
              following: prof.following,
              posts_count: prof.postsCount,
              views_30d: agg.views_30d,
              reels_30d: agg.reels_30d,
              likes_30d: agg.likes_30d,
              comments_30d: agg.comments_30d,
              raw: r.json,
            }],
            "account_id,taken_on"
          );

          if (acc.status === "introuvable") {
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

  await sbInsert("scan_log", [{
    accounts_scanned: toScan.length,
    errors,
    details: JSON.stringify({ introuvables: nowGone, retrouves: recovered }).slice(0, 500),
  }]);

  // Notification Telegram (si configurée)
  let msg = `📊 <b>Tracker Insta — scan terminé</b>\n${toScan.length} comptes relevés, ${errors} erreur(s).`;
  if (nowGone.length) msg += `\n⚠️ Introuvables : ${nowGone.join(", ")}`;
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
