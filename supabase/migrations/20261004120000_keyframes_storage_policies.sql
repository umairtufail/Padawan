-- Step keyframes (#41). The backend uploads and signs URLs AS THE USER, so storage row-level security
-- decides who may touch a file. Path layout: {user_id}/{session_id}/{t_ms}.jpg, so the first folder
-- is the owner. No policy for anon, none for other users: a stranger cannot read, sign or write.

alter table public.steps_draft add column keyframe_path text;

-- Small JPEGs only (the backend downscales to ~640 px wide).
update storage.buckets
   set file_size_limit = 1048576, allowed_mime_types = array['image/jpeg']
 where id = 'keyframes';

create policy keyframes_select_own on storage.objects for select to authenticated
  using (bucket_id = 'keyframes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy keyframes_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'keyframes' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- update is needed for upsert (the same t_ms uploaded twice)
create policy keyframes_update_own on storage.objects for update to authenticated
  using (bucket_id = 'keyframes' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'keyframes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy keyframes_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'keyframes' and (storage.foldername(name))[1] = (select auth.uid())::text);
