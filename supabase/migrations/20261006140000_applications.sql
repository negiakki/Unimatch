-- ============================================================================
-- UniMatch — Applications slice
--
-- Adds:
--   * public.applications — a user's participation in an opportunity. The
--     profile is NEVER duplicated: an application references the existing
--     profile and the opportunity, storing only participation state.
--
-- States: APPLIED -> WITHDRAWN (withdraw is a status transition; the row is
-- retained so re-applying is an UPDATE, not a new INSERT).
--
-- Duplicate prevention: UNIQUE(opportunity_id, profile_id) makes a second
-- application for the same user + opportunity impossible at the database
-- level.
--
-- RLS is enabled, deny-by-default:
--   * the owner may read their own applications (the "My Activity" surface);
--   * the owner may insert (apply) only when VERIFIED and the opportunity is
--     PUBLISHED;
--   * the owner may update (withdraw) only their own rows;
--   * there are deliberately no DELETE policies — withdrawal is a status
--     transition, not a row deletion;
--   * admin access runs through the service role.
--
-- No existing migration is modified. Storage RLS is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- applications — opportunity participation records (no profile duplication)
-- ---------------------------------------------------------------------------
create table public.applications (
  id             uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null,
  profile_id     uuid not null,
  status         text not null default 'APPLIED',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint applications_opportunity_id_fkey
    foreign key (opportunity_id) references public.opportunities (id) on delete cascade,
  constraint applications_profile_id_fkey
    foreign key (profile_id) references public.profiles (id) on delete cascade,

  -- One application per user per opportunity: the hard duplicate guarantee.
  constraint applications_opportunity_profile_key unique (opportunity_id, profile_id),
  constraint applications_status_valid check (status in ('APPLIED', 'WITHDRAWN'))
);

-- "My Activity" lookups scan by profile; admin queues scan by opportunity.
create index applications_profile_id_idx on public.applications (profile_id);
create index applications_opportunity_id_idx on public.applications (opportunity_id);

create trigger applications_set_updated_at
  before update on public.applications
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled, deny-by-default.
-- ---------------------------------------------------------------------------
alter table public.applications enable row level security;

-- SELECT: the caller may read only their own applications.
create policy "applications_select_own"
  on public.applications for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

-- INSERT: the caller applies with their OWN profile (never client input),
-- must be VERIFIED, and the opportunity must be PUBLISHED. The opportunity
-- subquery inherits opportunities' RLS (authenticated may read PUBLISHED
-- rows), so the check evaluates correctly for the caller. Duplicate
-- applications additionally fail the UNIQUE constraint.
create policy "applications_insert_own"
  on public.applications for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
    and public.is_current_user_verified()
    and exists (
      select 1 from public.opportunities o
      where o.id = opportunity_id
        and o.status = 'PUBLISHED'
    )
  );

-- UPDATE: the caller may update (withdraw / re-apply) only their own rows.
create policy "applications_update_own"
  on public.applications for update to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

-- No DELETE policies: withdrawal is a status transition (APPLIED -> WITHDRAWN).

-- ---------------------------------------------------------------------------
-- Privileges — explicit and minimal.
-- ---------------------------------------------------------------------------
revoke all on public.applications from anon;
grant select, insert, update on public.applications to authenticated;
revoke delete on public.applications from authenticated;

grant all on public.applications to service_role;
