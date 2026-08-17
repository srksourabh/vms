-- 000 — Baseline API-role grants for SELF-HOSTED (on-prem) Supabase.
--
-- On hosted supabase.com these privileges are provisioned by the platform, so
-- the historical migrations never granted table access to the PostgREST roles.
-- A self-hosted database has no such provisioning: without these grants every
-- request fails with "permission denied for table ...", even for service_role.
--
-- Row access is still governed by RLS for anon/authenticated (policies created
-- by later migrations); service_role has BYPASSRLS. Setting ALTER DEFAULT
-- PRIVILEGES here — before any table exists — means every table/sequence/
-- function created by migrations 001..NN inherits these grants automatically,
-- while deliberate REVOKEs in later migrations (e.g. 063 audit_logs) still take
-- effect because they run afterwards.
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- Cover any objects already present when this runs (none at 000; future-proof).
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
