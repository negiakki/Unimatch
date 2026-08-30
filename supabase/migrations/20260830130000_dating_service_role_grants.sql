-- ============================================================================
-- UniMatch — Phase 6 follow-up: service-role table grants
--
-- The Phase 6 tables (dating_actions, matches) were created without explicit
-- service-role grants. On hosted Supabase, default privileges do not cover
-- tables created by the migration runner, so the backend's service-role
-- client (atomic match creation, already-decided checks, soft unmatch) hit
-- `permission denied for table`. Every earlier slice grants service-role
-- access explicitly; this migration restores that convention for the Phase 6
-- tables. Idempotent and additive — no existing migration is modified.
-- ============================================================================

grant all on public.dating_actions to service_role;
grant all on public.matches to service_role;
