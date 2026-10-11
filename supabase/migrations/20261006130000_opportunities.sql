-- ============================================================================
-- UniMatch — Opportunities slice
--
-- Adds:
--   * public.opportunities — admin-created official opportunities/events
--     (Dandiya Night, Badminton Tournament, Movie Night, ...). This is the
--     core content entity: users discover opportunities, apply to them, and
--     discover people through them.
--
-- States: DRAFT -> PUBLISHED -> PAUSED -> CANCELLED -> EXPIRED.
-- Only PUBLISHED opportunities are publicly visible; all other states are
-- admin-only (service role).
--
-- RLS is enabled, deny-by-default. Public read is limited to PUBLISHED rows
-- for anon + authenticated (the landing page and discovery browse published
-- opportunities without sign-in). There are deliberately no INSERT/UPDATE/
-- DELETE policies for normal users: opportunities are created and managed
-- exclusively by admins through the service role (Admin Console).
--
-- No existing migration is modified. Storage RLS is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- opportunities — admin-created official opportunities/events
-- ---------------------------------------------------------------------------
create table public.opportunities (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  category_id        uuid not null,
  activity_id        uuid,
  description        text not null default '',
  opportunity_date   date,
  start_time         time,
  end_time           time,
  location           text,
  cover_image_url    text,
  capacity           integer,
  partner_requirement text,
  status             text not null default 'DRAFT',
  expiry             timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint opportunities_category_id_fkey
    foreign key (category_id) references public.categories (id) on delete restrict,
  constraint opportunities_activity_id_fkey
    foreign key (activity_id) references public.activities (id) on delete set null,
  constraint opportunities_created_by_fkey
    foreign key (created_by) references public.staff_admins (auth_user_id)
    on delete set null,

  constraint opportunities_title_valid check (
    title = btrim(title) and char_length(title) between 1 and 120
  ),
  constraint opportunities_description_valid check (
    char_length(description) between 0 and 2000
  ),
  constraint opportunities_location_valid check (
    location is null
    or (location = btrim(location) and char_length(location) between 1 and 200)
  ),
  constraint opportunities_cover_image_url_valid check (
    cover_image_url is null
    or (cover_image_url = btrim(cover_image_url)
        and char_length(cover_image_url) between 1 and 1024)
  ),
  constraint opportunities_capacity_valid check (
    capacity is null or capacity > 0
  ),
  constraint opportunities_partner_requirement_valid check (
    partner_requirement is null
    or (partner_requirement = btrim(partner_requirement)
        and char_length(partner_requirement) between 1 and 200)
  ),
  constraint opportunities_status_valid check (
    status in ('DRAFT', 'PUBLISHED', 'PAUSED', 'CANCELLED', 'EXPIRED')
  ),
  constraint opportunities_times_valid check (
    end_time is null or start_time is null or end_time > start_time
  ),
  constraint opportunities_expiry_valid check (
    expiry is null or expiry > created_at
  )
);

-- Public discovery scans by status; category browsing filters by category.
create index opportunities_status_idx on public.opportunities (status);
create index opportunities_category_id_idx on public.opportunities (category_id);
create index opportunities_activity_id_idx on public.opportunities (activity_id);

create trigger opportunities_set_updated_at
  before update on public.opportunities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled, deny-by-default.
-- ---------------------------------------------------------------------------
alter table public.opportunities enable row level security;

-- Public read: PUBLISHED opportunities only. DRAFT/PAUSED/CANCELLED/EXPIRED
-- are admin-only. The subquery on status is a plain column check (no RLS
-- self-reference issue).
create policy "opportunities_select_published"
  on public.opportunities for select
  to anon, authenticated
  using (status = 'PUBLISHED');

-- No INSERT/UPDATE/DELETE policies: opportunities are created and managed
-- only by the backend's service-role client (after FastAPI checks staff
-- authorization). Normal users hold no write grants either.

-- ---------------------------------------------------------------------------
-- Privileges — explicit and minimal.
-- ---------------------------------------------------------------------------
grant select on public.opportunities to anon, authenticated;
revoke insert, update, delete on public.opportunities from anon, authenticated;

grant all on public.opportunities to service_role;
