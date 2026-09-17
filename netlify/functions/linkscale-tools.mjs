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
