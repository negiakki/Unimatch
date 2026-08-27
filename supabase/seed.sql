-- ============================================================================
-- UniMatch — development seed data (fictional)
--
-- Applied by the Supabase CLI after migrations (`supabase db reset`) or
-- manually with psql. Idempotent: safe to run repeatedly.
--
-- Contains ONLY fictional universities and generic interest labels.
-- No real people, student identities, student ID numbers, profiles, or
-- verification documents — those are created by the app, never seeded.
-- ============================================================================

insert into public.universities (name, city, state, country) values
  ('Aldercrest University',              'Aldercrest',   'California',      'United States'),
  ('Northgate Institute of Technology',  'Northgate',    'New York',        'United States'),
  ('Rivermoor State University',         'Rivermoor',    'Ohio',            'United States'),
  ('University of Avonbridge',           'Avonbridge',   'England',         'United Kingdom'),
  ('Kestrel Bay University',             'Kestrel Bay',  'New South Wales', 'Australia'),
  ('Lindenfeld Technical University',    'Lindenfeld',   'Bavaria',         'Germany')
on conflict do nothing;

insert into public.interests (name) values
  ('Hiking'), ('Photography'), ('Cooking'), ('Board Games'), ('Live Music'),
  ('Reading'), ('Travel'), ('Gaming'), ('Football'), ('Basketball'),
  ('Running'), ('Coffee'), ('Film'), ('Art & Museums'), ('Volunteering'),
  ('Startups'), ('Dancing'), ('Fitness')
on conflict do nothing;
