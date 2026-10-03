-- Padawan initial schema. Keep in sync with Notion page 03.
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz default now()
);

create table skills (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles(id),
  title text not null,
  description text not null,
  domain text,
  language text default 'en',
  status text not null default 'draft',      -- draft | published
  skill_json jsonb,
  skill_md text,
  steps_count int default 0,
  guardrails_count int default 0,
  created_at timestamptz default now(),
  published_at timestamptz
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  kind text not null,                        -- teach | learn
  skill_id uuid references skills(id),
  status text not null default 'live',       -- live | debrief | processing | done | failed
  el_conversation_id text,
  off_record_ranges jsonb default '[]',
  report jsonb,
  started_at timestamptz default now(),
  ended_at timestamptz
);

create table events (
  id bigserial primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  t_ms int not null,
  kind text not null,
  summary text not null,
  payload jsonb,
  keyframe_path text
);

create table utterances (
  id bigserial primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  t_ms int not null,
  speaker text not null,                     -- expert | agent | learner | tutor
  text text not null
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  phase text not null,                       -- live | debrief
  type text not null,
  text text not null,
  anchor_event_id bigint references events(id),
  asked_at_ms int,
  answer_utterance_id bigint references utterances(id),
  why_now jsonb
);

create table steps_draft (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  idx int not null,
  title text not null,
  t_start_ms int, t_end_ms int,
  event_ids bigint[],
  question_ids uuid[],
  status text default 'open'
);

create table learn_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  learner_id uuid not null references profiles(id),
  skill_id uuid not null references skills(id),
  step_idx int not null,
  predicted text, actual text,
  correct boolean,
  intervened boolean default false,
  guardrail_id text,
  created_at timestamptz default now()
);

-- TODO (owner: data): enable RLS and add policies (see Notion page 03).
