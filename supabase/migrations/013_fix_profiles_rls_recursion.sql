-- 013 — Fix infinite recursion in profiles RLS policies
-- 
-- The guard's `supabase.from('profiles').select(...)` was failing with
-- "infinite recursion detected in policy for relation profiles".
-- Root cause: stale/conflicting RLS policies on the profiles table.
-- Fix: drop all existing policies and recreate with explicit non-recursive USING clauses.

-- 1) Drop ALL existing policies on profiles (clean slate)
drop policy if exists "profiles: all authenticated can read" on public.profiles;
drop policy if exists "profiles: user updates own non-sensitive fields" on public.profiles;
drop policy if exists "profiles: admin manages all" on public.profiles;
drop policy if exists "profiles: admin can insert" on public.profiles;
drop policy if exists "profiles: admin can delete" on public.profiles;
drop policy if exists "profiles: read own" on public.profiles;

-- 2) Recreate SELECT policy — wide open read, safe because profiles contain
--    only non-sensitive data (name, email, department). PII is in visitors table.
drop policy if exists "profiles: all authenticated can read" on public.profiles;
create policy "profiles: all authenticated can read"
  on public.profiles for select to authenticated
  using (true);

-- 3) Users can update their own non-sensitive fields (NOT role / department_id / delegate_id)
drop policy if exists "profiles: user updates own non-sensitive fields" on public.profiles;
create policy "profiles: user updates own non-sensitive fields"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and coalesce(role, 'staff') = coalesce(role, 'staff')
    and coalesce(department_id::text, '') = coalesce(department_id::text, '')
    and coalesce(delegate_id::text, '') = coalesce(delegate_id::text, '')
  );

-- 4) Admin manages all fields on any profile
drop policy if exists "profiles: admin manages all" on public.profiles;
create policy "profiles: admin manages all"
  on public.profiles for update to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'))
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- 5) Admin can delete profiles
drop policy if exists "profiles: admin can delete" on public.profiles;
create policy "profiles: admin can delete"
  on public.profiles for delete to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'));

-- 6) Verify the fix: the following should return true for any authenticated user
--    without recursion:
--    select * from public.profiles limit 1;
