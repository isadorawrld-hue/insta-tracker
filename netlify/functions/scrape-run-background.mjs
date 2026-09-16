// Fonction "background" (suffixe -background = 15 minutes autorisées).
// C'est elle qui fait le vrai travail. Déclenchée par le cron ou par le bouton admin.
import { runScan, checkInternalKey } from "./_shared.mjs";

export default async (req) => {
  if (!checkInternalKey(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const result = await runScan();
    console.log("Scan terminé:", JSON.stringify(result));
  } catch (e) {
    console.error("Scan échoué:", e);
  }
  return new Response("ok");
};
