-- Padawan schema. Backend uses the service-role key (bypasses RLS) and must filter by user id in code.
-- The browser uses the publishable key with the user's JWT, so RLS protects direct reads.

-- ---------- tables ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  domain text,
  language text not null default 'en',
  status text not null default 'draft' check (status in ('draft', 'published')),
  skill_json jsonb,
  skill_md text,
  steps_count int not null default 0,
  guardrails_count int not null default 0,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('teach', 'learn')),
  skill_id uuid references public.skills(id) on delete set null,
  status text not null default 'live' check (status in ('live', 'debrief', 'processing', 'done', 'failed')),
  title text,
  last_screen_summary text not null default '',
  el_conversation_id text,
  off_record_ranges jsonb not null default '[]',
  report jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  t_ms int not null,
  kind text not null,
  summary text not null,
  payload jsonb,
  keyframe_path text
);

create table public.utterances (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  t_ms int not null,
  speaker text not null check (speaker in ('expert', 'agent', 'learner', 'tutor')),
  text text not null
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  phase text not null check (phase in ('live', 'debrief')),
  type text not null,
  text text not null,
  anchor_event_id bigint references public.events(id) on delete set null,
  asked_at_ms int,
  answer_utterance_id bigint references public.utterances(id) on delete set null,
  why_now jsonb
);

create table public.steps_draft (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  idx int not null,
  title text not null,
  t_start_ms int,
  t_end_ms int,
  event_ids bigint[] not null default '{}',
  question_ids uuid[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'closed'))
);

create table public.learn_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  skill_id uuid not null references public.skills(id) on delete cascade,
  step_idx int not null,
  predicted text,
  actual text,
  correct boolean,
  intervened boolean not null default false,
  guardrail_id text,
  created_at timestamptz not null default now()
);

-- ---------- indexes (foreign keys and common lookups) ----------
create index skills_author_id_idx on public.skills (author_id);
create index skills_published_idx on public.skills (published_at desc) where status = 'published';
create index sessions_user_id_idx on public.sessions (user_id, started_at desc);
create index sessions_skill_id_idx on public.sessions (skill_id);
create index events_session_t_idx on public.events (session_id, t_ms);
create index utterances_session_t_idx on public.utterances (session_id, t_ms);
create index questions_session_id_idx on public.questions (session_id);
create index questions_anchor_event_idx on public.questions (anchor_event_id);
create index questions_answer_utterance_idx on public.questions (answer_utterance_id);
create index steps_draft_session_idx on public.steps_draft (session_id, idx);
create index learn_attempts_session_idx on public.learn_attempts (session_id);
create index learn_attempts_learner_skill_idx on public.learn_attempts (learner_id, skill_id);
create index learn_attempts_skill_idx on public.learn_attempts (skill_id);

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.skills enable row level security;
alter table public.sessions enable row level security;
alter table public.events enable row level security;
alter table public.utterances enable row level security;
alter table public.questions enable row level security;
alter table public.steps_draft enable row level security;
alter table public.learn_attempts enable row level security;

-- profiles: any signed-in user can read display names (shown on skill cards); only the owner edits.
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_update_own on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- skills: published ones are readable by everyone signed in; authors manage their own.
create policy skills_select on public.skills for select to authenticated
  using (status = 'published' or (select auth.uid()) = author_id);
create policy skills_insert_own on public.skills for insert to authenticated
  with check ((select auth.uid()) = author_id);
create policy skills_update_own on public.skills for update to authenticated
  using ((select auth.uid()) = author_id) with check ((select auth.uid()) = author_id);
create policy skills_delete_own on public.skills for delete to authenticated
  using ((select auth.uid()) = author_id);

-- sessions: owner only.
create policy sessions_select_own on public.sessions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy sessions_insert_own on public.sessions for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy sessions_update_own on public.sessions for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy sessions_delete_own on public.sessions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- session children: the owner can read (the backend writes with the service role).
create policy events_select_own on public.events for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = events.session_id and s.user_id = (select auth.uid())));
create policy utterances_select_own on public.utterances for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = utterances.session_id and s.user_id = (select auth.uid())));
create policy questions_select_own on public.questions for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = (select auth.uid())));
create policy steps_draft_select_own on public.steps_draft for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = steps_draft.session_id and s.user_id = (select auth.uid())));

-- learn attempts: the learner reads and records their own.
create policy learn_attempts_select_own on public.learn_attempts for select to authenticated
  using ((select auth.uid()) = learner_id);
create policy learn_attempts_insert_own on public.learn_attempts for insert to authenticated
  with check ((select auth.uid()) = learner_id);

-- ---------- Data API grants (signed-in users only, no anonymous access) ----------
revoke all on all tables in schema public from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.skills to authenticated;
grant select, insert, update, delete on public.sessions to authenticated;
grant select on public.events, public.utterances, public.questions, public.steps_draft to authenticated;
grant select, insert on public.learn_attempts to authenticated;

-- ---------- create a profile when someone signs up ----------
create schema if not exists private;

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Padawan'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------- storage: private bucket for step keyframes (backend uses signed URLs) ----------
insert into storage.buckets (id, name, public)
values ('keyframes', 'keyframes', false)
on conflict (id) do nothing;

-- ---------- realtime: live step ticker in the UI ----------
alter publication supabase_realtime add table public.steps_draft;
