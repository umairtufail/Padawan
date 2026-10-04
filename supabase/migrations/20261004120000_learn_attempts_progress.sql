-- Learn mode (#35): one learn_attempts row per (learn session, skill step) holds the learner's prediction,
-- the interventions and warnings Yoda raised, and the time spent. The backend upserts it as the learner
-- (forwarding their JWT), so the learner needs UPDATE, and the policies must check the session owner too.

alter table public.learn_attempts
  add column interventions int not null default 0,
  add column warnings int not null default 0,
  add column started_ms int,
  add column duration_ms int;

alter table public.learn_attempts
  add constraint learn_attempts_session_step_key unique (session_id, step_idx);

drop policy learn_attempts_insert_own on public.learn_attempts;

create policy learn_attempts_insert_own on public.learn_attempts for insert to authenticated
  with check (
    (select auth.uid()) = learner_id
    and exists (select 1 from public.sessions s where s.id = learn_attempts.session_id and s.user_id = (select auth.uid()))
  );

create policy learn_attempts_update_own on public.learn_attempts for update to authenticated
  using ((select auth.uid()) = learner_id)
  with check (
    (select auth.uid()) = learner_id
    and exists (select 1 from public.sessions s where s.id = learn_attempts.session_id and s.user_id = (select auth.uid()))
  );

grant update on public.learn_attempts to authenticated;
