-- Jedi Archives marketplace: learners take a published Holocron, authors see only aggregates.
--
-- 1. sessions.mastery_score: the final score (0..100) a learner got, written when the session finishes.
-- 2. skills_select_learner: a learner keeps read access to a skill they started, even after the author
--    unpublishes it (existing learn sessions must keep working). Nobody else sees the draft.
-- 3. private.skill_stats: counts WHO-FREE aggregates (distinct learners, average mastery) across all learners.
--    Row-level security hides other people's sessions, so this is a narrow SECURITY DEFINER function in a
--    schema that PostgREST does not expose. It checks auth.uid() and only answers for skills the caller may
--    see (published, or their own). public.skill_stats is a SECURITY INVOKER wrapper the API calls over RPC.
--    The author never learns who learned, only the numbers.

alter table public.sessions
  add column mastery_score int check (mastery_score is null or mastery_score between 0 and 100);

create index learn_attempts_session_id_idx on public.learn_attempts (session_id);

create policy skills_select_learner on public.skills for select to authenticated
  using (exists (
    select 1 from public.sessions s
    where s.skill_id = skills.id and s.kind = 'learn' and s.user_id = (select auth.uid())
  ));

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create function private.skill_stats(skill_ids uuid[])
returns table (skill_id uuid, learners_count bigint, avg_mastery numeric)
language sql
security definer
stable
set search_path = ''
as $$
  select k.id,
         count(distinct s.user_id) filter (where s.id is not null),
         round(avg(s.mastery_score) filter (where s.status = 'done' and s.mastery_score is not null), 1)
  from public.skills k
  left join public.sessions s on s.skill_id = k.id and s.kind = 'learn'
  where (select auth.uid()) is not null
    and k.id = any(skill_ids)
    and (k.status = 'published' or k.author_id = (select auth.uid()))
  group by k.id
$$;

revoke all on function private.skill_stats(uuid[]) from public, anon, authenticated;
grant execute on function private.skill_stats(uuid[]) to authenticated;

create function public.skill_stats(skill_ids uuid[])
returns table (skill_id uuid, learners_count bigint, avg_mastery numeric)
language sql
security invoker
stable
set search_path = ''
as $$
  select * from private.skill_stats(skill_ids)
$$;

revoke all on function public.skill_stats(uuid[]) from public, anon;
grant execute on function public.skill_stats(uuid[]) to authenticated;
