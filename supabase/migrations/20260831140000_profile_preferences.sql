-- ============================================================================
-- UniMatch — Profile preferences slice (Phase 9.3)
--
-- Adds:
--   * profiles.academic_year CHECK tightened 1–8 → 1–6. Pre-checked at
--     implementation time: zero rows with academic_year 7/8 existed, so the
--     swap is safe (policy: never silently rewrite existing 7/8 data — the
--     migration would fail loudly rather than destroy values).
--   * profiles.motivations text[] NOT NULL DEFAULT '{}' — why the user is on
--     UniMatch (dating / making_friends / confidence_and_communication).
--     Multiple selections allowed; the CHECK is the authority on the value
--     set (adding a future value is a constraint swap, never a data change).
--   * custom_interests — user-owned interest names, kept separate from the
--     shared read-only `interests` catalog (which stays immutable for users).
--     Case-insensitive uniqueness is per profile, not global.
--
-- Existing migrations are untouched. RLS stays deny-by-default everywhere.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Academic year 1–6.
--    Deliberately NO data rewrite: if a 7/8 row ever existed, adding the
--    tighter CHECK fails the migration loudly instead of silently changing
--    someone's answer.
-- ---------------------------------------------------------------------------
alter table public.profiles
  drop constraint profiles_academic_year_valid;

alter table public.profiles
  add constraint profiles_academic_year_valid
    check (academic_year between 1 and 6);

-- ---------------------------------------------------------------------------
-- 2. Motivations ("Why I'm here").
--    Empty array is valid at the DB level so the column default keeps
--    existing rows valid; the API layer requires 1–3 on every write.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column motivations text[] not null default '{}'::text[];

alter table public.profiles
  add constraint profiles_motivations_valid check (
    motivations <@ array[
      'dating', 'making_friends', 'confidence_and_communication'
    ]::text[]
  );

-- ---------------------------------------------------------------------------
-- 3. Custom interests — per-profile user-owned names.
--    Same 1–40 character rule as the shared catalog (interests_name_valid).
--    Uniqueness is per profile and case-insensitive (two users may both own
--    "Indie Game Design"; one user cannot own "gaming" AND "Gaming").
-- ---------------------------------------------------------------------------
create table public.custom_interests (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint custom_interests_profile_id_fkey
    foreign key (profile_id) references public.profiles (id) on delete cascade,
  constraint custom_interests_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 40
  )
);

-- Case-insensitive uniqueness WITHIN a profile. Expression index so
-- 'Gaming' vs 'gaming' collides while display casing is preserved.
create unique index custom_interests_profile_name_lower_key
  on public.custom_interests (profile_id, lower(name));

create index custom_interests_profile_id_idx
  on public.custom_interests (profile_id);

create trigger custom_interests_set_updated_at
  before update on public.custom_interests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Row Level Security — enabled, deny-by-default; owner-only DML using the
--    exact ownership predicate already used by profile_interests.
-- ---------------------------------------------------------------------------
alter table public.custom_interests enable row level security;

create policy "custom_interests_select_own"
  on public.custom_interests for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "custom_interests_insert_own"
  on public.custom_interests for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "custom_interests_update_own"
  on public.custom_interests for update to authenticated
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

create policy "custom_interests_delete_own"
  on public.custom_interests for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

-- Defense-in-depth cross-read for verified viewers, mirroring the discovery
-- slice's policy on profile_interests. The discovery feed itself runs on the
-- service role; this keeps direct-client reads consistent with profile data.
create policy "custom_interests_select_verified"
  on public.custom_interests for select to authenticated
  using (
    public.is_profile_verified(profile_id)
    and public.is_current_user_verified()
  );

-- ---------------------------------------------------------------------------
-- 5. Privileges — explicit and minimal, matching profile_interests.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete
  on public.custom_interests to authenticated;
