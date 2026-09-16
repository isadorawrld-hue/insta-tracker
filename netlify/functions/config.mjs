// Fournit la configuration publique au frontend.
// L'URL du projet et la cle anon (publique par design) vivent dans les
// variables d'environnement Netlify.
export default async () => {
return new Response(
JSON.stringify({
url: process.env.SUPABASE_URL || "",
anonKey: process.env.SUPABASE_ANON_KEY || "",
}),
{ headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
);
};
