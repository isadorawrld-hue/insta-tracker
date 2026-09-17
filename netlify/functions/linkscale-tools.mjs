// Découverte de l'API LinkScale.
// Interroge le point d'entrée MCP pour lister les outils accessibles
// avec la clé configurée, afin de brancher ensuite les bonnes requêtes.
// Protégé par le PIN admin : /.netlify/functions/linkscale-tools?pin=XXXX
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
  // le transport peut répondre en SSE : on extrait la ligne data:
  let payload = text;
  if (text.includes("data:")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (line) payload = line.slice(5).trim();
  }
  try { return { status: res.status, json: JSON.parse(payload) }; }
  catch { return { status: res.status, raw: text.slice(0, 2000) }; }
}

export default async (req) => {
  const url = new URL(req.url);
  const pin = url.searchParams.get("pin") || "";
  const settings = await getSettings();
  if (!pin || pin !== String(settings.admin_pin || "")) {
    return new Response("PIN invalide", { status: 403 });
  }
  if (!process.env.LINKSCALE_API_KEY) {
    return new Response("LINKSCALE_API_KEY absente des variables Netlify", { status: 400 });
  }

  const out = {};
  out.tools = await mcp("tools/list");

  // si un outil de statistiques existe, on tente un appel de démonstration
  const names = (out.tools?.json?.result?.tools || []).map((t) => t.name);
  out.tool_names = names;

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
