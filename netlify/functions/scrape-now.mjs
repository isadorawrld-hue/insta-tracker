// Déclenchement manuel depuis le dashboard admin.
// Vérifie le PIN admin puis lance la fonction background.
import { getSettings } from "./_shared.mjs";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let pin = "";
  try {
    const body = await req.json();
    pin = String(body.pin || "");
  } catch { /* ignore */ }

  const settings = await getSettings();
  if (!pin || pin !== String(settings.admin_pin || "")) {
    return new Response(JSON.stringify({ ok: false, error: "PIN invalide" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const base = process.env.URL;
  await fetch(`${base}/.netlify/functions/scrape-run-background`, {
    method: "POST",
    headers: { "x-internal-key": process.env.SUPABASE_SERVICE_KEY },
  });

  return new Response(JSON.stringify({ ok: true, message: "Scan lancé — résultats dans 1 à 3 minutes" }), {
    headers: { "Content-Type": "application/json" },
  });
};
