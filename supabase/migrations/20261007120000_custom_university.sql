-- ============================================================================
-- UniMatch — V1 university claim: curated catalog + custom universities
--
-- Adds:
--   * profiles.custom_university_name — free-text university for students
--     whose institution is not one of the four curated V1 institutions.
--   * profiles.university_id becomes nullable.
--   * profiles_university_claimed — a profile must claim EXACTLY ONE
--     university: either a catalog row (university_id set, custom name NULL)
--     or a custom institution (university_id NULL, custom name set).
--
-- V1 ships a deliberately small curated catalog (four Dehradun institutions)
-- plus the "my university isn't listed" escape hatch. A custom name never
-- creates a `universities` row: the catalog stays read-only reference data,
-- so an unreviewed institution can never leak into every other student's
-- dropdown.
--
-- Existing rows all have university_id set and no custom name, so they
-- satisfy the new constraint without a backfill.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: exactly-one university claim
-- ---------------------------------------------------------------------------
alter table public.profiles
  alter column university_id drop not null;

alter table public.profiles
  add column custom_university_name text;

alter table public.profiles
  add constraint profiles_custom_university_name_valid check (
    custom_university_name is null
    or (custom_university_name = btrim(custom_university_name)
        and char_length(custom_university_name) between 1 and 120)
  );

-- Exactly one of the two is set. Both-or-neither is rejected, so a profile can
-- never be ambiguous for a reviewer, and `university_id IS NULL` is a reliable
-- signal that the reviewer must read custom_university_name instead.
alter table public.profiles
  add constraint profiles_university_claimed check (
    (university_id is not null and custom_university_name is null)
    or (university_id is null and custom_university_name is not null)
  );

-- ---------------------------------------------------------------------------
-- universities: the four curated V1 institutions
-- ---------------------------------------------------------------------------
insert into public.universities (name, city, state, country) values
  ('Doon University',         'Dehradun', 'Uttarakhand', 'India'),
  ('DIT University',          'Dehradun', 'Uttarakhand', 'India'),
  ('UPES',                    'Dehradun', 'Uttarakhand', 'India'),
  ('Graphic Era University',  'Dehradun', 'Uttarakhand', 'India')
on conflict (lower(name), lower(city), lower(coalesce(state, '')), lower(country))
do nothing;

-- V1 drops the fictional catalog. Rows still referenced by an existing profile
-- are kept so the restrict FK stays satisfied — those students keep a working
-- university, and a reviewer can still compare it against their document.
delete from public.universities u
where not exists (
    select 1
    from (values
      ('Doon University'), ('DIT University'),
      ('UPES'), ('Graphic Era University')
    ) as curated(name)
    where lower(curated.name) = lower(u.name)
  )
  and not exists (
    select 1 from public.profiles p where p.university_id = u.id
  );
