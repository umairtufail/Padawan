-- The language of a teach session (the Master's language). The skill title, description and summary are written
-- in it. Before this column the Supabase repo lost it and every session was synthesized as "en".
-- Existing RLS policies on public.sessions already cover the new column (owner select / insert / update).
alter table public.sessions add column language text not null default 'en';
