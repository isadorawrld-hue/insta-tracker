// Diagnostic LinkScale : appelle n'importe quel outil et décrit la réponse.
//   /.netlify/functions/linkscale-tools?pin=XXXX
//   /.netlify/functions/linkscale-tools?pin=XXXX&tool=get_link_logs&args={"link_id":"...","source":"visits","limit":5}
import { getSettings } from "./_shared.mjs";

const MCP_URL = "https://dashboard.linkscale.to/api/mcp";

async function mcp(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINKSCALE_API_KEY || ""}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || {} }),
  });
  const text = await res.text();
  let payload = text;
  if (text.includes("data:")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (line) payload = line.slice(5).trim();
  }
  try { return { status: res.status, json: JSON.parse(payload) }; }
  catch { return { status: res.status, raw: text.slice(0, 4000) }; }
}

// Décrit la structure sans tout afficher
function shape(v, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    return depth > 3 ? `array(${v.length})`
      : { _array: v.length, _premier: v.length ? shape(v[0], depth + 1) : null };
  }
  if (typeof v === "object") {
    if (depth > 3) return "objet";
    const out = {};
    for (const [k, val] of Object.entries(v).slice(0, 40)) out[k] = shape(val, depth + 1);
    return out;
  }
  if (typeof v === "string") return v.length > 40 ? `texte(${v.length})` : v;
  return v;
}

export default async (req) => {
  const url = new URL(req.url);
  const pin = url.searchParams.get("pin") || "";
  const settings = await getSettings();
  if (!pin || pin !== String(settings.admin_pin || "")) {
    return new Response("PIN invalide", { status: 403 });
  }
  if (!process.env.LINKSCALE_API_KEY) {
    return new Response("LINKSCALE_API_KEY absente", { status: 400 });
  }

  const tool = url.searchParams.get("tool");
  let out;

  // Mode comptage : parcourt toutes les pages et compare aux totaux agrégés
  if (tool === "count") {
    const linkId = url.searchParams.get("link_id") || "";
    const days = Number(url.searchParams.get("days") || 30);
    const vt = url.searchParams.get("visitor_type") || "all";
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const to = new Date().toISOString();

    const compte = async (source) => {
      let cursor = null, lastId = null, total = 0, pages = 0, stop = "";
      for (let p = 0; p < 40; p++) {
        const args = { link_id: linkId, source, from, to, limit: 100, visitor_type: vt };
        if (cursor) args.next_cursor = cursor;
        if (lastId) args.last_id = lastId;
        const r = await mcp("tools/call", { name: "get_link_logs", arguments: args });
        const blocks = r?.json?.result?.content;
        let j = null;
        if (Array.isArray(blocks)) {
          for (const b of blocks) if (b?.type === "text") { try { j = JSON.parse(b.text); } catch {} break; }
        }
        const rows = Array.isArray(j?.data) ? j.data : [];
        total += rows.length; pages += 1;
        if (rows.length === 0) { stop = "page vide"; break; }
        const np = j?.next_page || {};
        const nc = np.next_cursor || j?.next_cursor || null;
        if (j?.has_more !== true) { stop = "has_more faux"; break; }
        if (!nc) { stop = "pas de curseur"; break; }
        if (nc === cursor) { stop = "curseur identique"; break; }
        cursor = nc; lastId = np.last_id || j?.last_id || null;
        if (p === 39) stop = "plafond 40 pages";
      }
      return { total, pages, stop };
    };

    // totaux agrégés, pour comparer
    const st = await mcp("tools/call", { name: "get_link_stats",
      arguments: { link_id: linkId, from, to } });
    let sj = null;
    const sb = st?.json?.result?.content;
    if (Array.isArray(sb)) for (const b of sb) if (b?.type === "text") { try { sj = JSON.parse(b.text); } catch {} break; }

    out = {
      lien: linkId, jours: days, visitor_type: vt,
      logs_visites: await compte("visits"),
      logs_clics: await compte("clicks"),
      totaux_agreges: sj?.stats?.summary || sj?.truncated_for_transport || "indisponible",
    };
    return new Response(JSON.stringify(out, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!tool) {
    const r = await mcp("tools/list");
    out = { outils: (r?.json?.result?.tools || []).map((t) => t.name) };
  } else {
    let args = {};
    try { args = JSON.parse(url.searchParams.get("args") || "{}"); } catch { /* ignore */ }
    const r = await mcp("tools/call", { name: tool, arguments: args });
    const blocks = r?.json?.result?.content;
    let parsed = null;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          try { parsed = JSON.parse(b.text); } catch { parsed = { texte: b.text.slice(0, 3000) }; }
          break;
        }
      }
    }
    out = { outil: tool, arguments: args, structure: shape(parsed), extrait: JSON.stringify(parsed).slice(0, 3000) };
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
