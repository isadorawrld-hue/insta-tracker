// Fonction planifiée — tourne chaque nuit à 21:00 UTC = 04:00 Bangkok
// (horaire défini dans netlify.toml). Elle ne fait que déclencher la
// fonction background, qui a 15 minutes pour tout scanner.

export default async () => {
  const base = process.env.URL; // fourni automatiquement par Netlify
  await fetch(`${base}/.netlify/functions/scrape-run-background`, {
    method: "POST",
    headers: { "x-internal-key": process.env.SUPABASE_SERVICE_KEY },
  });
  return new Response("triggered");
};
