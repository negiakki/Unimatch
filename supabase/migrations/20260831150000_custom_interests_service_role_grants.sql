-- ============================================================================
-- UniMatch — Follow-up: service-role grant for custom_interests
--
-- The Phase 9.3 table (custom_interests) was created without an explicit
-- service-role grant; only `authenticated` received privileges. On hosted
-- Supabase, default privileges do not cover tables created by the migration
-- runner, so the backend's service-role client hit
-- `permission denied for table custom_interests` (42501) on every flow that
-- resolves interests (discovery, matches, messaging, profile) and surfaced
-- 503 `database_unavailable`. This is the same failure mode already fixed
-- for the Phase 6 tables in 20260830130000_dating_service_role_grants.sql.
--
-- Insert/update/delete are granted because the backend writes replace-sets
-- for a profile's custom interests with the service-role client. Idempotent
-- and additive — no existing migration is modified.
-- ============================================================================

grant select, insert, update, delete
  on public.custom_interests
  to service_role;
