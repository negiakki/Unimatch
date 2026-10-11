-- ============================================================================
-- UniMatch — Category & activity catalog slice
--
-- Adds:
--   * public.categories — data-driven opportunity categories (Sports, Events,
--     Entertainment, Social, Travel). Admin-managed: readable by everyone,
--     writable only through the service role (Admin Console).
--   * public.activities — activities belonging to a category (Badminton,
--     Dandiya, Movies, ...). Same RLS shape as categories.
--
-- The category system is intentionally data-driven: admins create, rename,
-- reorder, enable/disable categories and activities without frontend or
-- schema changes.
--
-- RLS is enabled on both tables, deny-by-default. Reference data is readable
-- by anon + authenticated (mirrors universities/interests); there are
-- deliberately no INSERT/UPDATE/DELETE policies for normal users.
--
-- No existing migration is modified. Storage RLS is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- categories — opportunity categories (reference data, admin-managed)
-- ---------------------------------------------------------------------------
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null,
  icon       text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint categories_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 60
  ),
  constraint categories_slug_valid check (
    slug = btrim(slug) and char_length(slug) between 1 and 60
  ),
  constraint categories_sort_order_valid check (sort_order >= 0)
);

-- Case-insensitive uniqueness prevents obvious duplicates ('Sports' vs
-- 'sports') while preserving canonical display casing.
create unique index categories_name_lower_key on public.categories (lower(name));
create unique index categories_slug_key on public.categories (lower(slug));

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- activities — activities within a category (reference data, admin-managed)
-- ---------------------------------------------------------------------------
create table public.activities (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null,
  name        text not null,
  slug        text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint activities_category_id_fkey
    foreign key (category_id) references public.categories (id) on delete cascade,
  constraint activities_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 60
  ),
  constraint activities_slug_valid check (
    slug = btrim(slug) and char_length(slug) between 1 and 60
  ),
  constraint activities_sort_order_valid check (sort_order >= 0)
);

-- Uniqueness is per category: 'Movies' may exist under both SOCIAL and
-- ENTERTAINMENT, but not twice under the same category.
create unique index activities_category_name_lower_key
  on public.activities (category_id, lower(name));
create unique index activities_category_slug_key
  on public.activities (category_id, lower(slug));

create index activities_category_id_idx on public.activities (category_id);

create trigger activities_set_updated_at
  before update on public.activities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled everywhere, deny-by-default.
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;
alter table public.activities enable row level security;

-- Reference data: readable by all signed-in or anonymous clients. There are
-- intentionally no INSERT/UPDATE/DELETE policies; combined with the revokes
-- below, normal users cannot modify the catalogs. The service role bypasses
-- RLS and manages catalog content (Admin Console).
create policy "categories_read_all"
  on public.categories for select
  to anon, authenticated
  using (true);

create policy "activities_read_all"
  on public.activities for select
  to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Privileges — explicit and minimal (mirrors universities/interests).
-- ---------------------------------------------------------------------------
grant select on public.categories, public.activities to anon, authenticated;
revoke insert, update, delete
  on public.categories, public.activities
  from anon, authenticated;

grant all on public.categories, public.activities to service_role;
