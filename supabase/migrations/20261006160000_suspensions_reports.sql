-- ============================================================================
-- UniMatch — Suspensions & report opportunity context slice
--
-- Adds:
--   * public.suspensions — minimal admin-managed account suspensions.
--     suspended_until NULL means indefinite; otherwise the profile is
--     suspended until that timestamp. Enforcement (auth/discovery/messaging
--     gates) is backend logic, applied later — this migration provides the
--     storage and RLS only.
--   * Extends reports.content_type to accept 'opportunity', so a report can
--     reference an opportunity/event in addition to a profile/message/photo.
--
-- RLS is enabled on suspensions, deny-by-default, with NO user policies:
-- suspensions are admin-only (service role). The reports CHECK swap is
-- additive in spirit (widens the accepted value set, no data change).
--
-- No existing migration is modified. Storage RLS is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- suspensions — one row per admin-issued suspension (nullable expiry).
-- ---------------------------------------------------------------------------
create table public.suspensions (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null,
  reason          text not null,
  suspended_until timestamptz,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),

  constraint suspensions_profile_id_fkey
    foreign key (profile_id) references public.profiles (id) on delete cascade,
  constraint suspensions_created_by_fkey
    foreign key (created_by) references public.staff_admins (auth_user_id)
    on delete restrict,

  constraint suspensions_reason_valid check (
    reason = btrim(reason) and char_length(reason) between 1 and 500
  ),
  constraint suspensions_until_valid check (
    suspended_until is null or suspended_until > created_at
  )
);

create index suspensions_profile_id_idx on public.suspensions (profile_id);

alter table public.suspensions enable row level security;

-- Deliberately NO policies: suspensions are admin-only (service role). There
-- is no user SELECT policy — a suspended user must not see who suspended
-- them or why beyond what the backend surfaces through its own (later) API.

revoke all on public.suspensions from anon, authenticated;
grant all on public.suspensions to service_role;

-- ---------------------------------------------------------------------------
-- reports.content_type — widen accepted values to include 'opportunity'.
-- ---------------------------------------------------------------------------
alter table public.reports
  drop constraint reports_content_type_valid;

alter table public.reports
  add constraint reports_content_type_valid check (
    content_type is null
    or content_type in ('profile', 'message', 'photo', 'opportunity')
  );
