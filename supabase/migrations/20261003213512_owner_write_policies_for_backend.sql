-- The backend calls Supabase as the signed-in user (forwarding their JWT), so the owner of a session
-- needs to be able to write its children. Ownership is always checked through the parent session.

create policy events_insert_own on public.events for insert to authenticated
  with check (exists (select 1 from public.sessions s where s.id = events.session_id and s.user_id = (select auth.uid())));

create policy utterances_insert_own on public.utterances for insert to authenticated
  with check (exists (select 1 from public.sessions s where s.id = utterances.session_id and s.user_id = (select auth.uid())));

create policy questions_insert_own on public.questions for insert to authenticated
  with check (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = (select auth.uid())));
create policy questions_update_own on public.questions for update to authenticated
  using (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = (select auth.uid())));

create policy steps_draft_insert_own on public.steps_draft for insert to authenticated
  with check (exists (select 1 from public.sessions s where s.id = steps_draft.session_id and s.user_id = (select auth.uid())));
create policy steps_draft_update_own on public.steps_draft for update to authenticated
  using (exists (select 1 from public.sessions s where s.id = steps_draft.session_id and s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.sessions s where s.id = steps_draft.session_id and s.user_id = (select auth.uid())));

grant insert on public.events, public.utterances, public.questions, public.steps_draft to authenticated;
grant update on public.questions, public.steps_draft to authenticated;
