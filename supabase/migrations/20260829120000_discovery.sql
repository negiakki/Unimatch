-- ============================================================================
-- UniMatch — Discovery slice: VERIFIED gate + cross-user read policies
--
-- Adds:
--   * public.is_profile_verified(profile_id uuid) -> boolean — a SECURITY
--     DEFINER boolean helper that reveals ONLY whether a profile's latest
--     verification submission is VERIFIED. It returns a single boolean, never
--     a status string: an arbitrary authenticated caller can learn "verified
--     or not" for a profile, but never PENDING/REJECTED/VERIFIED directly, and
--     never the submission rows themselves (RLS still hides those).
--   * public.is_current_user_verified() -> boolean — SECURITY DEFINER helper
--     that resolves the CALLER's own profile from auth.uid() and evaluates the
--     same gate. Kept separate so the SELECT policies never self-reference
--     `profiles` (PostgreSQL rejects a policy subquery on its own table with
--     "infinite recursion detected in policy", 42P17).
--   * Three cross-user SELECT policies (defense-in-depth for the discovery
--     feed): a verified authenticated user may SELECT the public-facing rows
--     (profiles, profile_photos, profile_interests) of OTHER verified
--     profiles. Owner-only access is unchanged and retained.
--
-- No new tables. Storage RLS is unchanged. Existing migrations are untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- VERIFIED-gate helpers (SECURITY DEFINER, locked search_path).
--
-- is_profile_verified: true ONLY when the latest submission
-- (submitted_at desc, the server-assigned monotonic order) is VERIFIED.
-- false for PENDING, REJECTED, a profile with no submissions, or a
-- nonexistent profile. Runs as the function owner (bypasses RLS) so RLS
-- policies and the backend gate can evaluate it, but the boolean result is
-- all any caller can observe — never the underlying status.
-- ---------------------------------------------------------------------------
create or replace function public.is_profile_verified(profile_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((
    select v.status = 'VERIFIED'
    from public.verification_submissions v
    where v.profile_id = $1
    order by v.submitted_at desc
    limit 1
  ), false);
$$;

-- Caller's own gate: resolve the caller's profile via auth.uid() (never
-- client input) and evaluate the same check.
create or replace function public.is_current_user_verified()
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_profile_id uuid;
begin
  select p.id into caller_profile_id
  from public.profiles p
  where p.auth_user_id = auth.uid()
  limit 1;
  if caller_profile_id is null then
    return false;
  end if;
  return public.is_profile_verified(caller_profile_id);
end;
$$;

-- Privileges: execute for authenticated only. `public` (incl. `anon`) is
-- revoked so anonymous callers cannot probe verification state at all.
revoke all on function public.is_profile_verified(uuid) from public;
revoke all on function public.is_current_user_verified() from public;
grant execute on function public.is_profile_verified(uuid) to authenticated;
grant execute on function public.is_current_user_verified() to authenticated;

-- ---------------------------------------------------------------------------
-- Cross-user SELECT policies (discovery read surface).
--
-- Every policy requires BOTH sides of the gate:
--   * the target row belongs to a VERIFIED profile (is_profile_verified);
--   * the current viewer is VERIFIED (is_current_user_verified).
-- An unverified viewer gains no cross-read access. Owner-only SELECT policies
-- from the core schema remain intact, so an unverified owner still reads
-- their own rows (and verified owners keep their own rows too).
-- ---------------------------------------------------------------------------

create policy "profiles_select_verified"
  on public.profiles for select to authenticated
  using (
    public.is_profile_verified(id)
    and public.is_current_user_verified()
  );

create policy "profile_photos_select_verified"
  on public.profile_photos for select to authenticated
  using (
    public.is_profile_verified(profile_id)
    and public.is_current_user_verified()
  );

create policy "profile_interests_select_verified"
  on public.profile_interests for select to authenticated
  using (
    public.is_profile_verified(profile_id)
    and public.is_current_user_verified()
  );
