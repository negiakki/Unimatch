-- ============================================================================
-- UniMatch — Follow-up: service-role execute grant for pair_is_blocked
--
-- 20260831120000_safety_blocks_reports.sql redefined send_conversation_message
-- to exclude matches with an active block via pair_is_blocked(), but granted
-- EXECUTE on that helper to `authenticated` only. The send RPC is
-- invoker-rights, so the backend's service-role client hit
-- `permission denied for function pair_is_blocked` (42501) on EVERY send,
-- surfacing as 503 `database_insert_failed` / "Messaging is temporarily
-- unavailable." Same failure mode as 20260831150000 (custom_interests grants):
-- hosted Supabase default privileges do not cover functions created by the
-- migration runner. RLS callers (authenticated) already have the grant;
-- service_role bypasses RLS and only reaches this function through the RPC.
--
-- Idempotent and additive — no existing migration is modified.
-- ============================================================================

grant execute on function public.pair_is_blocked(uuid, uuid) to service_role;
