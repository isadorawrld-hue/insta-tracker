-- ============================================
-- SENSUAL AURA — TRACKER INSTAGRAM
-- Script à coller dans Supabase > SQL Editor > Run
-- ============================================

create extension if not exists pgcrypto;

-- Modèles (Kim, Mia, etc.)
create table if not exists models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Comptes Instagram farmés
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  model_id uuid references models(id) on delete set null,
  device_ref text,                          -- ex: iPhoneX_01
  va_name text,                             -- qui gère le compte
  started_on date not null default current_date,  -- date de création du compte IG
  status text not null default 'actif',     -- actif | introuvable | banni | supprime
  status_changed_on date,
  rating int not null default 0,            -- 0 à 5 étoiles
  notes text,
  active boolean not null default true,     -- false = archivé
  created_at timestamptz not null default now()
);

-- Relevés quotidiens (1 ligne par compte et par jour)
create table if not exists snapshots (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  taken_on date not null default current_date,
  followers int,
  following int,
  posts_count int,
  views_30d bigint,       -- somme des vues des posts < 30 jours
  reels_30d int,          -- nb de posts < 30 jours
  likes_30d int,
  comments_30d int,
  raw jsonb,              -- réponse brute (sécurité si le parsing évolue)
  created_at timestamptz not null default now(),
  unique(account_id, taken_on)
);

create index if not exists idx_snapshots_account_date on snapshots(account_id, taken_on desc);

-- Réglages de l'app (PINs, seuils)
create table if not exists app_settings (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb
);

insert into app_settings (id, data)
values (1, '{"admin_pin":"8888","va_pin":"2222","seuil_vues":500}')
on conflict (id) do nothing;

-- Journal des scans (pour vérifier que le cron tourne)
create table if not exists scan_log (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  accounts_scanned int,
  errors int,
  details text
);
