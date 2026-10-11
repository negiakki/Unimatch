-- ============================================================================
-- UniMatch — development seed data (fictional)
--
-- Applied by the Supabase CLI after migrations (`supabase db reset`) or
-- manually with psql. Idempotent: safe to run repeatedly.
--
-- Contains ONLY the curated V1 university catalog and generic interest labels.
-- No real people, student identities, student ID numbers, profiles, or
-- verification documents — those are created by the app, never seeded.
--
-- V1 curates four institutions. Students whose university is absent pick "My
-- university isn't listed" and store a free-text custom_university_name
-- instead; that never creates a catalog row.
-- ============================================================================

insert into public.universities (name, city, state, country) values
  ('Doon University',         'Dehradun', 'Uttarakhand', 'India'),
  ('DIT University',          'Dehradun', 'Uttarakhand', 'India'),
  ('UPES',                    'Dehradun', 'Uttarakhand', 'India'),
  ('Graphic Era University',  'Dehradun', 'Uttarakhand', 'India')
on conflict (lower(name), lower(city), lower(coalesce(state, '')), lower(country))
do nothing;

insert into public.interests (name) values
  ('Hiking'), ('Photography'), ('Cooking'), ('Board Games'), ('Live Music'),
  ('Reading'), ('Travel'), ('Gaming'), ('Football'), ('Basketball'),
  ('Running'), ('Coffee'), ('Film'), ('Art & Museums'), ('Volunteering'),
  ('Startups'), ('Dancing'), ('Fitness')
on conflict do nothing;

-- Opportunity categories (reference data, admin-managed in the console).
-- Uniqueness is case-insensitive on name/slug.
insert into public.categories (name, slug, icon, sort_order) values
  ('Sports',        'sports',        'sports', 10),
  ('Events',        'events',        'events', 20),
  ('Entertainment', 'entertainment', 'movies', 30),
  ('Social',        'social',        'social', 40),
  ('Travel',        'travel',        'travel', 50)
on conflict (lower(name)) do nothing;

-- Activities per category (reference data, admin-managed in the console).
-- Uniqueness is per category and case-insensitive on name.
insert into public.activities (category_id, name, slug, sort_order)
select c.id, a.name, a.slug, a.sort_order
from (values
  ('sports', 'Badminton',   'badminton',    10),
  ('sports', 'Table Tennis','table-tennis', 20),
  ('sports', 'Pickleball',  'pickleball',   30),
  ('sports', 'Football',    'football',     40),
  ('sports', 'Basketball',  'basketball',   50),
  ('sports', 'Cricket',     'cricket',      60),
  ('sports', 'Volleyball',  'volleyball',   70),
  ('sports', 'Tennis',      'tennis',       80),
  ('sports', 'Running',     'running',      90),
  ('events', 'Dandiya',     'dandiya',      10),
  ('events', 'Garba',       'garba',        20),
  ('events', 'Holi',        'holi',         30),
  ('events', 'Christmas',   'christmas',    40),
  ('events', 'New Year',    'new-year',     50),
  ('events', 'College Fest','college-fest', 60),
  ('events', 'Concert',     'concert',      70),
  ('events', 'Cultural Event','cultural-event', 80),
  ('events', 'Festival',    'festival',     90),
  ('entertainment', 'Movies',  'movies',  10),
  ('entertainment', 'Gaming',  'gaming',  20),
  ('entertainment', 'Shows',   'shows',   30),
  ('entertainment', 'Concert', 'concert', 40),
  ('entertainment', 'Cafes',   'cafes',   50),
  ('social', 'Hangout',          'hangout',          10),
  ('social', 'Explore the City', 'explore-the-city', 20),
  ('social', 'Food',             'food',             30),
  ('social', 'Weekend Plans',    'weekend-plans',    40),
  ('travel', 'Rishikesh',   'rishikesh',   10),
  ('travel', 'Mussoorie',   'mussoorie',   20),
  ('travel', 'Trek',        'trek',        30),
  ('travel', 'Road Trip',   'road-trip',   40),
  ('travel', 'Weekend Trip','weekend-trip',50)
) as a (cat_slug, name, slug, sort_order)
join public.categories c on lower(c.slug) = a.cat_slug
on conflict (category_id, lower(name)) do nothing;
