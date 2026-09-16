# Sensual Aura — Tracker Instagram
## Guide de mise en ligne (15 minutes)

Même recette que Manager Minute : Supabase + GitHub + Netlify.

---

## Les clés vivent dans Netlify (variables d'environnement) :
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_KEY
- SCRAPECREATORS_API_KEY
- (optionnel) TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID

Après chaque changement de variable : Deploys → Trigger deploy.

PIN admin par défaut : 8888 — PIN VA : 2222 (à changer dans Réglages).
Le scan auto tourne chaque nuit à 04:00 Bangkok.
Si un scan ne tourne pas : Netlify → Logs → Functions → scrape-run-background.
