-- 096 — Create the private visitor-photos storage bucket (self-hosted).
--
-- The app uploads the check-in photo to this bucket and falls back to a base64
-- column if it is missing, so the UI works either way — but the bucket must
-- exist for real photo storage (and for the storage RLS policies created in
-- migrations 016/019, which reference bucket_id = 'visitor-photos'). On hosted
-- Supabase the bucket was created by hand; a self-hosted DB creates it here.
insert into storage.buckets (id, name, public)
values ('visitor-photos', 'visitor-photos', false)
on conflict (id) do nothing;
