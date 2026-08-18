-- Add avatar_url column to profiles for user profile photos
alter table public.profiles add column if not exists avatar_url text;

-- Storage bucket for profile avatars (public so images load without signed URLs)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Anyone authenticated can upload their own avatar (path = user_id/*)
drop policy if exists "avatars: users can upload own avatar" on storage.objects;
create policy "avatars: users can upload own avatar"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Anyone can read avatars (public bucket)
drop policy if exists "avatars: public read" on storage.objects;
create policy "avatars: public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'avatars');

-- Users can update/delete their own avatar
drop policy if exists "avatars: users can update own avatar" on storage.objects;
create policy "avatars: users can update own avatar"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars: users can delete own avatar" on storage.objects;
create policy "avatars: users can delete own avatar"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
