-- ============================================================================
-- UniMatch — Core database schema (first slice)
--
-- Creates: universities, profiles, interests, profile_interests,
--          profile_photos
--
-- Notes:
--   * Targets Supabase PostgreSQL: `auth.users` is managed by Supabase Auth
--     and is referenced (never duplicated). No credentials live in this file.
--   * Row Level Security is enabled on every table, deny-by-default.
--   * Verification, dating, matching, messaging, safety, and notification
--     tables are intentionally NOT part of this migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- universities — catalog of supported universities (reference data)
-- ---------------------------------------------------------------------------
create table public.universities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  city       text not null,
  state      text,
  country    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint universities_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 200
  ),
  constraint universities_city_valid check (
    city = btrim(city) and char_length(city) between 1 and 100
  ),
  constraint universities_state_valid check (
    state is null
    or (state = btrim(state) and char_length(state) between 1 and 100)
  ),
  constraint universities_country_valid check (
    country = btrim(country) and char_length(country) between 1 and 100
  )
);

-- Prevent accidental duplicate universities (case-insensitive). `state` is
-- optional, so it is normalized to '' for uniqueness. Distinct campuses of
-- the same name remain representable via city/state/country.
create unique index universities_identity_key
  on public.universities (
    lower(name), lower(city), lower(coalesce(state, '')), lower(country)
  );

-- ---------------------------------------------------------------------------
-- profiles — the dating profile, 1:1 with a Supabase Auth user
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key default gen_random_uuid(),
  auth_user_id        uuid not null,
  first_name          text not null,
  date_of_birth       date not null,
  university_id       uuid not null,
  course              text not null,
  academic_year       smallint not null,
  gender              text not null,
  seeking_gender      text not null,
  bio                 text not null,
  relationship_intent text,
  height_cm           smallint,
  hometown            text,
  profile_prompts     jsonb not null default '[]'::jsonb,
  social_links        jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One profile per authenticated user; the auth identity is the source of
  -- truth. Deleting the auth user deletes the profile (and, in turn, its
  -- photos and interest links).
  constraint profiles_auth_user_id_key unique (auth_user_id),
  constraint profiles_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users (id) on delete cascade,

  -- UniMatch is 18+ only. Evaluated against the server's CURRENT_DATE at
  -- write time (PostgreSQL permits non-immutable expressions in CHECK
  -- constraints; see docs/DATABASE.md "Known limitations" for the caveat
  -- and why it is safe for this monotonic comparison).
  constraint profiles_age_18_plus check (
    date_of_birth <= current_date - interval '18 years'
  ),
  constraint profiles_date_of_birth_realistic check (
    date_of_birth >= date '1900-01-01'
  ),
  constraint profiles_first_name_valid check (
    first_name = btrim(first_name)
    and char_length(first_name) between 1 and 50
  ),
  constraint profiles_university_id_fkey
    foreign key (university_id) references public.universities (id) on delete restrict,
  constraint profiles_course_valid check (
    course = btrim(course) and char_length(course) between 1 and 120
  ),
  constraint profiles_academic_year_valid check (
    academic_year between 1 and 8
  ),
  constraint profiles_gender_valid check (
    gender in ('woman', 'man', 'non_binary', 'other')
  ),
  constraint profiles_seeking_gender_valid check (
    seeking_gender in ('women', 'men', 'everyone')
  ),
  constraint profiles_bio_valid check (
    bio = btrim(bio) and char_length(bio) between 1 and 500
  ),
  constraint profiles_relationship_intent_valid check (
    relationship_intent in ('casual', 'serious', 'friendship', 'not_sure')
  ),
  constraint profiles_height_cm_valid check (height_cm between 100 and 250),
  constraint profiles_hometown_valid check (
    hometown is null
    or (hometown = btrim(hometown) and char_length(hometown) between 1 and 100)
  ),
  constraint profiles_prompts_is_array check (
    jsonb_typeof(profile_prompts) = 'array'
  ),
  constraint profiles_social_links_is_object check (
    jsonb_typeof(social_links) = 'object'
  )
);

create index profiles_university_id_idx on public.profiles (university_id);

-- ---------------------------------------------------------------------------
-- interests — shared interest catalog (reference data)
-- ---------------------------------------------------------------------------
create table public.interests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now(),

  constraint interests_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 40
  )
);

-- Case-insensitive uniqueness prevents obvious duplicates ('Gaming' vs
-- 'gaming') while preserving canonical display casing.
create unique index interests_name_lower_key on public.interests (lower(name));

-- ---------------------------------------------------------------------------
-- profile_interests — many-to-many: profiles <-> interests
-- ---------------------------------------------------------------------------
create table public.profile_interests (
  profile_id  uuid not null,
  interest_id uuid not null,
  created_at  timestamptz not null default now(),

  constraint profile_interests_pkey primary key (profile_id, interest_id),
  constraint profile_interests_profile_id_fkey
    foreign key (profile_id) references public.profiles (id) on delete cascade,
  constraint profile_interests_interest_id_fkey
    foreign key (interest_id) references public.interests (id) on delete cascade
);

create index profile_interests_interest_id_idx
  on public.profile_interests (interest_id);

-- ---------------------------------------------------------------------------
-- profile_photos — ordered photo records; binaries live in Supabase Storage
-- ---------------------------------------------------------------------------
create table public.profile_photos (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null,
  storage_path text not null,
  position     smallint not null,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint profile_photos_profile_id_fkey
    foreign key (profile_id) references public.profiles (id) on delete cascade,
  constraint profile_photos_storage_path_key unique (storage_path),
  constraint profile_photos_storage_path_valid check (
    storage_path = btrim(storage_path)
    and char_length(storage_path) between 1 and 1024
  ),
  constraint profile_photos_position_valid check (position >= 1),
  constraint profile_photos_profile_position_key unique (profile_id, position)
);

-- At most one primary photo per profile.
create unique index profile_photos_one_primary_per_profile_idx
  on public.profile_photos (profile_id) where is_primary;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger universities_set_updated_at
  before update on public.universities
  for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger profile_photos_set_updated_at
  before update on public.profile_photos
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled everywhere, deny-by-default.
-- (select auth.uid()) is wrapped in a subselect so the plan evaluates it once.
-- ---------------------------------------------------------------------------
alter table public.universities      enable row level security;
alter table public.profiles          enable row level security;
alter table public.interests         enable row level security;
alter table public.profile_interests enable row level security;
alter table public.profile_photos    enable row level security;

-- Reference data: readable by all signed-in or anonymous clients.
-- There are intentionally no INSERT/UPDATE/DELETE policies; combined with the
-- revokes below, normal users cannot modify the catalogs. The service role
-- bypasses RLS and manages catalog content.
create policy "universities_read_all"
  on public.universities for select
  to anon, authenticated
  using (true);

create policy "interests_read_all"
  on public.interests for select
  to anon, authenticated
  using (true);

-- Profiles: owner-only. Broader read policies for discovery/matches will be
-- added by the verification/discovery slices; they are intentionally absent
-- here.
create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (auth_user_id = (select auth.uid()));

create policy "profiles_insert_own"
  on public.profiles for insert to authenticated
  with check (auth_user_id = (select auth.uid()));

create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

create policy "profiles_delete_own"
  on public.profiles for delete to authenticated
  using (auth_user_id = (select auth.uid()));

-- Profile interests: rows may only be read from and attached to the caller's
-- own profile.
create policy "profile_interests_select_own"
  on public.profile_interests for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "profile_interests_insert_own"
  on public.profile_interests for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "profile_interests_update_own"
  on public.profile_interests for update to authenticated
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

create policy "profile_interests_delete_own"
  on public.profile_interests for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

-- Profile photos: owner-only.
create policy "profile_photos_select_own"
  on public.profile_photos for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "profile_photos_insert_own"
  on public.profile_photos for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "profile_photos_update_own"
  on public.profile_photos for update to authenticated
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

create policy "profile_photos_delete_own"
  on public.profile_photos for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Privileges — explicit and minimal. RLS is the security boundary; grants
-- keep anon/authenticated from even reaching non-public tables. The service
-- role bypasses RLS (managed by Supabase) and keeps full table access.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

grant select on public.universities, public.interests to anon, authenticated;
revoke insert, update, delete
  on public.universities, public.interests
  from anon, authenticated;

grant select, insert, update, delete
  on public.profiles, public.profile_interests, public.profile_photos
  to authenticated;

grant all on all tables in schema public to service_role;
