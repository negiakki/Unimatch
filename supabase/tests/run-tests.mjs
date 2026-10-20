#!/usr/bin/env node
// ============================================================================
// UniMatch — database tests for the core + verification schema slices.
//
// Applies every migration from supabase/migrations/ (in filename order) to an
// embedded PostgreSQL (@electric-sql/pglite) and exercises constraints + RLS
// as real SQL.
//
// A minimal Supabase Auth EMULATION (auth.users table, auth.uid() function,
// anon/authenticated/service_role roles) is installed first — it exists only
// for local testing. Production uses the real Supabase Auth objects; nothing
// in the migration depends on this emulation beyond what Supabase provides.
//
// Run from supabase/tests/:   npm install && npm test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));

// --- locate the migrations ---------------------------------------------------
const migrationDir = join(here, '..', 'migrations');
const migrationFiles = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort();
assert.ok(
  migrationFiles.length >= 1,
  'expected at least one migration file in supabase/migrations/'
);
const migrationSqls = migrationFiles.map((f) => readFileSync(join(migrationDir, f), 'utf8'));
const seedSql = readFileSync(join(here, '..', 'seed.sql'), 'utf8');

const EXPIRY_24H_MIGRATION = '20261020120000_conversation_expiry_24h.sql';
const expiry24hIndex = migrationFiles.indexOf(EXPIRY_24H_MIGRATION);
assert.ok(expiry24hIndex >= 0, `missing migration ${EXPIRY_24H_MIGRATION}`);
const expiry24hSql = migrationSqls[expiry24hIndex];

// Applies every migration BEFORE the 24h slice to an isolated database, so a
// migration-level failure can be exercised without touching the main fixture
// database.
async function applyMigrationsBeforeExpiry(targetDb) {
  for (let i = 0; i < expiry24hIndex; i += 1) {
    await targetDb.exec(migrationSqls[i]);
  }
}

// --- database ---------------------------------------------------------------
const db = new PGlite(); // in-memory PostgreSQL

async function exec(sql) {
  await db.exec(sql);
}

async function rows(sql, params = []) {
  const res = await db.query(sql, params);
  return res.rows;
}

async function one(sql, params = []) {
  const r = await rows(sql, params);
  assert.equal(r.length, 1, `expected exactly 1 row, got ${r.length} for: ${sql}`);
  return r[0];
}

// Number of rows returned by a mutating statement written as `... returning 1`.
// RLS-filtered UPDATE/DELETE touch 0 rows; WITH CHECK violations throw.
async function touched(sql, params = []) {
  return (await rows(sql, params)).length;
}

// --- role / identity switching (Supabase emulation) -------------------------
async function actAsService() {
  await exec('reset role;');
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
}

async function actAs(userId) {
  await exec('reset role;');
  if (userId === null) {
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await exec('set role anon;');
    return;
  }
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await exec('set role authenticated;');
}

async function expectFailure(run, ...needles) {
  try {
    await run();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (needles.length > 0 && !needles.some((n) => msg.includes(n))) {
      assert.fail(`error did not match any of [${needles.join(' | ')}]: ${msg}`);
    }
    return msg;
  }
  assert.fail('expected the statement to fail, but it succeeded');
}

// --- setup: Supabase Auth + pg_cron emulation, then migrations --------------
// Shared by the main database and the isolated failure-mode databases below.
const bootstrapSql = `
  create schema if not exists auth;
  create table if not exists auth.users (
    id         uuid primary key default gen_random_uuid(),
    email      text unique,
    created_at timestamptz not null default now()
  );

  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin bypassrls;
    end if;
  end $$;

  create or replace function auth.uid() returns uuid
  language sql stable
  as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $fn$;

  -- Minimal Supabase STORAGE emulation: only the objects the storage
  -- migrations reference (buckets + objects + foldername). Test-only; real
  -- Supabase Storage provides these in production.
  create schema if not exists storage;
  create table if not exists storage.buckets (
    id                 text primary key,
    name               text not null,
    public             boolean not null default false,
    file_size_limit    bigint,
    allowed_mime_types text[]
  );
  create table if not exists storage.objects (
    id        uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets (id),
    name      text not null,
    metadata  jsonb
  );
  create unique index if not exists storage_objects_bucket_name_key
    on storage.objects (bucket_id, name);
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text) returns text[]
  language sql immutable
  as $fn$
    select string_to_array(name, '/')
  $fn$;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  grant all on storage.objects to service_role;
`;

// Minimal pg_cron emulation: the migration only needs the job table and the
// schedule/unschedule functions. Test-only; hosted Supabase supplies the real
// extension. This lets the success and failure paths run locally.
const fakeCronSql = `
  create schema if not exists cron;
  create table if not exists cron.job (
    jobid    bigserial primary key,
    jobname  text not null unique,
    schedule text not null,
    command  text not null,
    active   boolean not null default true
  );
  create or replace function cron.schedule(
    job_name text,
    schedule text,
    command text
  ) returns bigint
  language plpgsql
  as $fn$
  declare
    v_jobid bigint;
  begin
    insert into cron.job (jobname, schedule, command)
    values (job_name, schedule, command)
    on conflict (jobname) do update
      set schedule = excluded.schedule,
          command = excluded.command
    returning jobid into v_jobid;
    return v_jobid;
  end;
  $fn$;
  create or replace function cron.unschedule(job_name text)
  returns boolean
  language plpgsql
  as $fn$
  begin
    delete from cron.job where jobname = job_name;
    return found;
  end;
  $fn$;
`;

await actAsService();
await exec(bootstrapSql);
await exec(fakeCronSql);

// Apply every migration exactly as the Supabase CLI would (filename order).
for (const sql of migrationSqls) {
  await exec(sql);
}

// --- fixtures (service-role context) ----------------------------------------
const university = await one(`
  insert into public.universities (name, city, state, country)
  values ('Fixture University', 'Fixture City', 'Fixture State', 'United States')
  returning id, name
`);
const interestA = await one(`insert into public.interests (name) values ('Fixture Interest A') returning id`);
const interestB = await one(`insert into public.interests (name) values ('Fixture Interest B') returning id`);

// --- contextual-matching fixtures ------------------------------------------
// A category + activity (fixture names/slugs are unique vs the seed data) and
// a helper to create PUBLISHED opportunities used by the opportunity,
// application, dating/matching and safety tests.
const catFixture = await one(`
  insert into public.categories (name, slug, icon, sort_order)
  values ('Fixture Category', 'fixture-category', null, 0) returning id
`);
const actFixture = await one(
  `insert into public.activities (category_id, name, slug, sort_order)
   values ($1, 'Fixture Activity', 'fixture-activity', 0) returning id`,
  [catFixture.id]
);
async function insertPublishedOpportunity(title) {
  return one(
    `insert into public.opportunities
       (title, category_id, activity_id, description, opportunity_date, status)
     values ($1, $2, $3, 'fixture description', now()::date, 'PUBLISHED')
     returning id`,
    [title, catFixture.id, actFixture.id]
  );
}
const oppId = (await insertPublishedOpportunity('Fixture Event')).id;

const userA = await one(`insert into auth.users (email) values ('a@example.test') returning id`);
const userB = await one(`insert into auth.users (email) values ('b@example.test') returning id`);
const userC = await one(`insert into auth.users (email) values ('c@example.test') returning id`);
const userD = await one(`insert into auth.users (email) values ('d@example.test') returning id`);
const userE = await one(`insert into auth.users (email) values ('e@example.test') returning id`);

const PROFILE_COLUMNS = `(auth_user_id, first_name, date_of_birth, university_id,
  course, academic_year, gender, seeking_gender, bio)`;

async function insertProfileAsOwner(userId) {
  await actAs(userId);
  return one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, 'Alice', current_date - interval '20 years', $2,
             'Computer Science', 2, 'woman', 'everyone', 'Hello there')
     returning id`,
    [userId, university.id]
  );
}

const profileA = await insertProfileAsOwner(userA.id);
const profileB = await insertProfileAsOwner(userB.id);
const profileC = await insertProfileAsOwner(userC.id);

// --- verification slice fixtures ---------------------------------------------
// Back to service-role context (the profile fixtures above ended as their
// owners). A registered staff reviewer and two ordinary users (with profiles)
// dedicated to the verification tests.
await actAsService();
const userStaff = await one(`insert into auth.users (email) values ('staff@example.test') returning id`);
await one(`insert into public.staff_admins (auth_user_id) values ($1) returning auth_user_id`, [userStaff.id]);

const userV = await one(`insert into auth.users (email) values ('v@example.test') returning id`);
const userW = await one(`insert into auth.users (email) values ('w@example.test') returning id`);
const profileV = await insertProfileAsOwner(userV.id);
const profileW = await insertProfileAsOwner(userW.id);

// Submissions created by the verification tests below.
let submissionV1; // V's first submission (PENDING -> REJECTED)
let submissionV2; // V's resubmission (PENDING -> VERIFIED)

// ============================================================================
// Tests
// ============================================================================

test('01 · migrations create exactly the expected tables on a clean database', async () => {
  // information_schema only lists tables the current role has privileges on;
  // service role sees everything (suspensions grants are admin-only).
  await actAsService();
  const t = await rows(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  assert.deepEqual(
    t.map((r) => r.table_name).sort(),
    [
      'activities',
      'applications',
      'blocks',
      'categories',
      'custom_interests',
      'dating_actions',
      'interests',
      'matches',
      'messages',
      'opportunities',
      'profile_interests',
      'profile_photos',
      'profiles',
      'reports',
      'staff_admins',
      'suspensions',
      'universities',
      'verification_reviews',
      'verification_submissions',
    ]
  );
});

test('02 · RLS is enabled on every table and policies exist', async () => {
  const tables = await rows(`
    select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  `);
  assert.equal(tables.length, 19);
  for (const t of tables) {
    assert.equal(t.relrowsecurity, true, `${t.relname} must have RLS enabled`);
  }
  const policies = await rows(`
    select tablename, count(*)::int as n from pg_policies
    where schemaname = 'public'
    group by tablename
  `);
  const byTable = Object.fromEntries(policies.map((p) => [p.tablename, p.n]));
  assert.equal(byTable['universities'], 1);
  assert.equal(byTable['interests'], 1);
  assert.equal(byTable['categories'], 1); // read_all
  assert.equal(byTable['activities'], 1); // read_all
  assert.equal(byTable['opportunities'], 1); // select_published
  assert.equal(byTable['applications'], 3); // select_own + insert_own + update_own
  assert.equal(byTable['suspensions'], undefined); // admin-only (no user policies)
  assert.equal(byTable['profiles'], 5); // 4 owner + profiles_select_verified
  assert.equal(byTable['profile_interests'], 5); // 4 owner + _select_verified
  assert.equal(byTable['profile_photos'], 5); // 4 owner + _select_verified
  assert.equal(byTable['staff_admins'], 1);
  assert.equal(byTable['verification_submissions'], 3);
  assert.equal(byTable['verification_reviews'], 1);
  assert.equal(byTable['dating_actions'], 2); // insert_own + select_own_outgoing
  assert.equal(byTable['matches'], 1); // select_participant (participants, no active block)
  assert.equal(byTable['messages'], 1); // select_participant (active match, no active block)
  assert.equal(byTable['blocks'], 3); // insert_own + select_own_outgoing + delete_own
  assert.equal(byTable['reports'], 2); // insert_own + select_staff
  assert.equal(byTable['custom_interests'], 5); // 4 owner + _select_verified
});

// Phase 9.3 — academic year 1–6, motivations, custom interests.

test('phase 9.3 · academic_year outside 1–6 is rejected by the database', async () => {
  await actAs(userA.id);
  const valid = await rows(
    `update public.profiles set academic_year = 6 where id = $1 returning id`,
    [profileA.id]
  );
  assert.equal(valid.length, 1);
  for (const bad of [0, 7, 8]) {
    await assert.rejects(
      () =>
        rows(
          `update public.profiles set academic_year = $2 where id = $1 returning id`,
          [profileA.id, bad]
        ),
      /profiles_academic_year_valid/
    );
  }
  await rows(`update public.profiles set academic_year = 1 where id = $1`, [profileA.id]);
});

test('phase 9.3 · motivations accepts only the controlled value set', async () => {
  await actAs(userA.id);
  const saved = await rows(
    `update public.profiles set motivations = $1::text[] where id = $2 returning motivations`,
    ['{dating,confidence_and_communication}', profileA.id]
  );
  assert.deepEqual(saved[0].motivations, ['dating', 'confidence_and_communication']);
  // Column default is the empty array.
  await rows(`update public.profiles set motivations = '{}'::text[] where id = $1`, [profileA.id]);
  const empty = await rows(`select motivations from public.profiles where id = $1`, [profileA.id]);
  assert.deepEqual(empty[0].motivations, []);
  // Unknown values are rejected by the CHECK.
  await assert.rejects(
    () =>
      rows(
        `update public.profiles set motivations = '{friendship}'::text[] where id = $1`,
        [profileA.id]
      ),
    /profiles_motivations_valid/
  );
  await rows(`update public.profiles set motivations = '{}'::text[] where id = $1`, [profileA.id]);
});

test('phase 9.3 · custom interests are owner-scoped by RLS and case-insensitively unique per profile', async () => {
  // A creates two custom interests on their own profile.
  await actAs(userA.id);
  const created = await rows(
    `insert into public.custom_interests (profile_id, name)
     values ($1, 'Indie Game Design'), ($1, 'knit')
     returning id, name`,
    [profileA.id]
  );
  assert.equal(created.length, 2);

  // Per-profile case-insensitive uniqueness (same owner, different case).
  await expectFailure(
    () =>
      rows(
        `insert into public.custom_interests (profile_id, name) values ($1, 'KNIT')`,
        [profileA.id]
      ),
    'custom_interests_profile_name_lower_key'
  );

  // The other profile may own the same name — uniqueness is per profile.
  await actAs(userB.id);
  await one(
    `insert into public.custom_interests (profile_id, name) values ($1, 'KNIT') returning id`,
    [profileB.id]
  );

  // Owner reads exactly their own rows.
  await actAs(userA.id);
  const mine = await rows(`select name from public.custom_interests order by name`);
  assert.deepEqual(mine.map((r) => r.name), ['Indie Game Design', 'knit']);

  // B cannot see A's rows and cannot delete them (RLS filters the DELETE).
  await actAs(userB.id);
  const crossRead = await rows(`select * from public.custom_interests`);
  assert.equal(crossRead.length, 1); // only B's own 'KNIT'
  assert.equal(
    await touched(
      `delete from public.custom_interests where profile_id = $1 returning 1`,
      [profileA.id]
    ),
    0
  );

  // B cannot insert into A's profile (WITH CHECK violation).
  await expectFailure(
    () =>
      rows(
        `insert into public.custom_interests (profile_id, name) values ($1, 'hijack')`,
        [profileA.id]
      ),
    'row-level security'
  );

  // Name rule: 1–40 trimmed characters.
  await actAsService();
  await expectFailure(
    () =>
      rows(
        `insert into public.custom_interests (profile_id, name) values ($1, '  ')`,
        [profileA.id]
      ),
    'custom_interests_name_valid'
  );
  await expectFailure(
    () =>
      rows(
        `insert into public.custom_interests (profile_id, name) values ($1, repeat('x', 41))`,
        [profileA.id]
      ),
    'custom_interests_name_valid'
  );

  // Clean up — later tests must not see these rows.
  await rows(`delete from public.custom_interests where profile_id = $1`, [profileA.id]);
  await rows(`delete from public.custom_interests where profile_id = $1`, [profileB.id]);
});

test('phase 9.3 · deleting the auth user cascades custom interests away', async () => {
  await actAsService();
  const throwawayUser = await one(
    `insert into auth.users (email) values ('cascade-check@example.test') returning id`
  );
  const throwawayProfile = await one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, 'Cara', current_date - interval '20 years', $2,
             'Design', 2, 'woman', 'men', 'Temporary profile')
     returning id`,
    [throwawayUser.id, university.id]
  );
  await one(
    `insert into public.custom_interests (profile_id, name)
     values ($1, 'Cascade Check') returning id`,
    [throwawayProfile.id]
  );
  await rows(`delete from auth.users where id = $1`, [throwawayUser.id]);
  assert.equal(
    (await rows(`select 1 from public.custom_interests where profile_id = $1`, [throwawayProfile.id])).length,
    0
  );
});

test('03 · profile links 1:1 to the auth user (owner can create and read it)', async () => {
  await actAs(userA.id);
  const mine = await rows(`select * from public.profiles`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, profileA.id);
  assert.equal(mine[0].auth_user_id, userA.id);
});

test('04 · duplicate profile for the same auth user is prevented', async () => {
  // Attempted by the owner…
  await actAs(userA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.profiles ${PROFILE_COLUMNS}
         values ($1, 'Alice2', current_date - interval '20 years', $2,
                 'Math', 1, 'woman', 'men', 'Second profile')
         returning id`,
        [userA.id, university.id]
      ),
    'profiles_auth_user_id_key'
  );
  // …and even with the RLS bypass of a privileged context.
  await actAsService();
  await expectFailure(
    () =>
      rows(
        `insert into public.profiles ${PROFILE_COLUMNS}
         values ($1, 'Alice3', current_date - interval '20 years', $2,
                 'Math', 1, 'woman', 'men', 'Third profile')
         returning id`,
        [userA.id, university.id]
      ),
    'profiles_auth_user_id_key'
  );
});

test('05 · duplicate profile-interest relationship is prevented', async () => {
  await actAs(userA.id);
  await rows(
    `insert into public.profile_interests (profile_id, interest_id) values ($1, $2)`,
    [profileA.id, interestA.id]
  );
  await expectFailure(
    () =>
      rows(
        `insert into public.profile_interests (profile_id, interest_id) values ($1, $2)`,
        [profileA.id, interestA.id]
      ),
    'profile_interests_pkey'
  );
});

test('06 · foreign keys: deleting a profile cascades photos and interests, never the university', async () => {
  await actAs(userC.id);
  await rows(
    `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
     values ($1, 'profiles/c/photo-1.jpg', 1, true)`,
    [profileC.id]
  );
  await rows(
    `insert into public.profile_interests (profile_id, interest_id) values ($1, $2)`,
    [profileC.id, interestB.id]
  );

  // Owner deletes own profile.
  await actAs(userC.id);
  assert.equal(await touched(`delete from public.profiles where id = $1 returning 1`, [profileC.id]), 1);

  await actAsService();
  assert.equal((await rows(`select 1 from public.profile_photos where profile_id = $1`, [profileC.id])).length, 0);
  assert.equal((await rows(`select 1 from public.profile_interests where profile_id = $1`, [profileC.id])).length, 0);
  // The university is untouched by profile deletion.
  assert.equal((await rows(`select 1 from public.universities where id = $1`, [university.id])).length, 1);
});

test('07 · foreign keys: deleting the auth user cascades the profile away', async () => {
  await actAsService();
  assert.equal((await rows(`select 1 from public.profiles where id = $1`, [profileC.id])).length, 0);
  await rows(`delete from auth.users where id = $1`, [userC.id]);
  assert.equal((await rows(`select 1 from public.profiles where auth_user_id = $1`, [userC.id])).length, 0);
});

test('08 · profile cannot reference a nonexistent university', async () => {
  await actAs(userD.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.profiles ${PROFILE_COLUMNS}
         values ($1, 'Bob', current_date - interval '19 years', $2,
                 'Physics', 1, 'man', 'women', 'Hi')
         returning id`,
        [userD.id, '00000000-0000-0000-0000-000000000000']
      ),
    'profiles_university_id_fkey',
    'violates foreign key constraint'
  );
});

test('09 · photo ownership relationship works (owner manages own photos)', async () => {
  await actAs(userA.id);
  await one(
    `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
     values ($1, 'profiles/a/photo-1.jpg', 1, true)
     returning id`,
    [profileA.id]
  );
  assert.equal((await rows(`select * from public.profile_photos where profile_id = $1`, [profileA.id])).length, 1);

  // A second primary photo for the same profile is rejected.
  await expectFailure(
    () =>
      rows(
        `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
         values ($1, 'profiles/a/photo-2.jpg', 2, true)`,
        [profileA.id]
      ),
    'profile_photos_one_primary_per_profile_idx'
  );

  // Duplicate ordering value for the same profile is rejected…
  await expectFailure(
    () =>
      rows(
        `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
         values ($1, 'profiles/a/photo-3.jpg', 1, false)`,
        [profileA.id]
      ),
    'profile_photos_profile_position_key'
  );

  // …while a different position for the same profile is fine.
  await rows(
    `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
     values ($1, 'profiles/a/photo-4.jpg', 2, false)`,
    [profileA.id]
  );

  // Storage paths are globally unique (each Storage object maps to one row).
  await actAs(userB.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
         values ($1, 'profiles/a/photo-1.jpg', 1, false)`,
        [profileB.id]
      ),
    'profile_photos_storage_path_key'
  );
  await actAsService();
  await rows(`delete from public.profile_photos where profile_id = $1`, [profileA.id]);
});

test('10 · RLS: a user cannot read or modify another user’s profile', async () => {
  await actAs(userB.id);

  // B sees only their own profile.
  const visible = await rows(`select id from public.profiles`);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, profileB.id);

  // UPDATE on A's profile matches no rows (USING filter) and changes nothing.
  assert.equal(
    await touched(`update public.profiles set first_name = 'Hacked' where id = $1 returning 1`, [profileA.id]),
    0
  );

  // DELETE on A's profile matches no rows.
  assert.equal(await touched(`delete from public.profiles where id = $1 returning 1`, [profileA.id]), 0);

  // INSERT claiming A's auth identity violates the WITH CHECK clause.
  await expectFailure(
    () =>
      rows(
        `insert into public.profiles ${PROFILE_COLUMNS}
         values ($1, 'Impostor', current_date - interval '30 years', $2,
                 'Law', 3, 'man', 'women', 'Not my id')
         returning id`,
        [userA.id, university.id]
      ),
    'row-level security'
  );

  // A's data is unchanged.
  await actAs(userA.id);
  const a = await one(`select first_name from public.profiles where id = $1`, [profileA.id]);
  assert.equal(a.first_name, 'Alice');
});

test('11 · RLS: a user cannot modify another user’s photos', async () => {
  // A re-creates a photo to protect.
  await actAs(userA.id);
  await rows(
    `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
     values ($1, 'profiles/a/photo-1.jpg', 1, true)`,
    [profileA.id]
  );

  await actAs(userB.id);
  assert.equal(
    (await rows(`select 1 from public.profile_photos where profile_id = $1`, [profileA.id])).length,
    0
  );
  assert.equal(
    await touched(
      `update public.profile_photos set position = 9 where profile_id = $1 returning 1`,
      [profileA.id]
    ),
    0
  );
  assert.equal(
    await touched(`delete from public.profile_photos where profile_id = $1 returning 1`, [profileA.id]),
    0
  );
  await expectFailure(
    () =>
      rows(
        `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
         values ($1, 'profiles/a/hijack.jpg', 3, false)`,
        [profileA.id]
      ),
    'row-level security'
  );

  // The photo was not modified.
  await actAs(userA.id);
  const p = await one(`select position from public.profile_photos where profile_id = $1`, [profileA.id]);
  assert.equal(p.position, 1);
});

test('12 · RLS: a user cannot modify another user’s profile interests', async () => {
  await actAs(userB.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.profile_interests (profile_id, interest_id) values ($1, $2)`,
        [profileA.id, interestB.id]
      ),
    'row-level security'
  );
  assert.equal(
    await touched(`delete from public.profile_interests where profile_id = $1 returning 1`, [profileA.id]),
    0
  );
  assert.equal(
    await touched(
      `update public.profile_interests set created_at = now() where profile_id = $1 returning 1`,
      [profileA.id]
    ),
    0
  );
  assert.equal(
    (await rows(`select 1 from public.profile_interests where profile_id = $1`, [profileA.id])).length,
    0
  );
});

test('13 · normal users cannot modify universities (read-only reference data)', async () => {
  await actAs(userA.id);
  await expectFailure(
    () =>
      rows(`insert into public.universities (name, city, country) values ('X', 'Y', 'Z')`),
    'permission denied'
  );
  await expectFailure(
    () => rows(`update public.universities set name = 'X' where id = $1`, [university.id]),
    'permission denied'
  );
  await expectFailure(
    () => rows(`delete from public.universities where id = $1`, [university.id]),
    'permission denied'
  );

  // …but reference data is readable by anonymous visitors too.
  await actAs(null);
  assert.equal((await rows(`select 1 from public.universities`)).length >= 1, true);
});

test('14 · normal users cannot modify the global interest catalog', async () => {
  await actAs(userA.id);
  await expectFailure(() => rows(`insert into public.interests (name) values ('Nope')`), 'permission denied');
  await expectFailure(
    () => rows(`update public.interests set name = 'Nope' where id = $1`, [interestA.id]),
    'permission denied'
  );
  await expectFailure(
    () => rows(`delete from public.interests where id = $1`, [interestA.id]),
    'permission denied'
  );

  await actAs(null);
  assert.equal((await rows(`select 1 from public.interests`)).length >= 1, true);
});

test('15 · 18+ requirement enforced dynamically against the current date', async () => {
  await actAs(userE.id);

  // 17-year-old → rejected by the age check.
  await expectFailure(
    () =>
      rows(
        `insert into public.profiles ${PROFILE_COLUMNS}
         values ($1, 'Kid', (current_date - interval '17 years')::date, $2,
                 'Biology', 1, 'woman', 'everyone', 'Too young')
         returning id`,
        [userE.id, university.id]
      ),
    'profiles_age_18_plus'
  );

  // Future birth date → also rejected.
  await expectFailure(
    () =>
      rows(
        `insert into public.profiles ${PROFILE_COLUMNS}
         values ($1, 'Timetraveler', (current_date + interval '1 day')::date, $2,
                 'Biology', 1, 'woman', 'everyone', 'Not born yet')
         returning id`,
        [userE.id, university.id]
      ),
    'profiles_age_18_plus'
  );

  // Exactly 18 years before today → allowed (the cutoff is dynamic, not a
  // hardcoded calendar date).
  const adult = await one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, 'Just18', (current_date - interval '18 years')::date, $2,
             'Chemistry', 1, 'man', 'women', 'Exactly eighteen today')
     returning id`,
    [userE.id, university.id]
  );
  assert.ok(adult.id);
});

test('16 · updated_at is maintained automatically on update', async () => {
  await actAs(userA.id);
  const before = await one(`select created_at, updated_at from public.profiles where id = $1`, [profileA.id]);
  await rows(`update public.profiles set bio = 'Updated bio' where id = $1`, [profileA.id]);
  const after = await one(`select created_at, updated_at from public.profiles where id = $1`, [profileA.id]);
  assert.equal(after.created_at.getTime(), before.created_at.getTime());
  assert.ok(after.updated_at.getTime() > before.created_at.getTime());
});

test('17 · seed file applies cleanly and is idempotent', async () => {
  await actAsService();
  await exec(seedSql);
  const uniCount = (await rows(`select count(*)::int as n from public.universities`))[0].n;
  const interestCount = (await rows(`select count(*)::int as n from public.interests`))[0].n;
  assert.ok(uniCount >= 4, `expected at least 4 seeded universities, got ${uniCount}`);
  assert.ok(interestCount >= 18, `expected at least 18 seeded interests, got ${interestCount}`);

  // Second run must not duplicate anything.
  await exec(seedSql);
  assert.equal((await rows(`select count(*)::int as n from public.universities`))[0].n, uniCount);
  assert.equal((await rows(`select count(*)::int as n from public.interests`))[0].n, interestCount);
});

test('84 · the seeded university catalog is exactly the four curated V1 institutions', async () => {
  await actAsService();
  const names = (await rows(`select name from public.universities order by name`)).map((r) => r.name);
  const CURATED = [
    'DIT University',
    'Doon University',
    'Graphic Era University',
    'UPES',
  ];
  for (const name of CURATED) {
    assert.ok(names.includes(name), `missing curated university ${name} in ${JSON.stringify(names)}`);
  }
  // The fictional pre-V1 catalog must be gone from seed data.
  for (const fictional of ['Aldercrest University', 'Rivermoor State University', 'Lindenfeld Technical University']) {
    assert.ok(!names.includes(fictional), `fictional university ${fictional} is still present`);
  }
});

// ============================================================================
// Verification slice tests
// ============================================================================

test('18 · verification: owner can create a submission for their own profile', async () => {
  await actAs(userV.id);
  const sub = await one(
    `insert into public.verification_submissions (profile_id, storage_path)
     values ($1, 'student-ids/v/submission-1.jpg')
     returning id, status, submitted_at, reviewed_at, reviewer_id, rejection_reason,
              created_at, updated_at`,
    [profileV.id]
  );
  submissionV1 = sub;
  assert.equal(sub.status, 'PENDING');
  assert.equal(sub.reviewed_at, null);
  assert.equal(sub.reviewer_id, null);
  assert.equal(sub.rejection_reason, null);
  // submitted_at is server-assigned (trigger), never client-chosen.
  assert.ok(sub.submitted_at instanceof Date);
  assert.ok(sub.submitted_at.getTime() >= sub.created_at.getTime());

  // The owner can read their own submission back (only their own).
  const mine = await rows(`select * from public.verification_submissions`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, sub.id);
});

test('19 · verification: a user cannot create or read another user’s submission', async () => {
  await actAs(userW.id);

  // INSERT targeting userV's profile must be denied: ownership is derived
  // from auth.uid() through profiles, never from the client-supplied id.
  await expectFailure(
    () =>
      rows(
        `insert into public.verification_submissions (profile_id, storage_path)
         values ($1, 'student-ids/hijack/id.jpg')`,
        [profileV.id]
      ),
    'row-level security'
  );

  // userW sees no verification rows at all (userV's are invisible).
  assert.equal((await rows(`select * from public.verification_submissions`)).length, 0);

  // The hijack attempt created nothing for profileV.
  await actAsService();
  assert.equal(
    (await rows(`select 1 from public.verification_submissions where profile_id = $1`, [profileV.id])).length,
    1
  );
});

test('20 · verification: a second active PENDING submission for the same profile is rejected', async () => {
  await actAs(userV.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.verification_submissions (profile_id, storage_path)
         values ($1, 'student-ids/v/submission-2.jpg')`,
        [profileV.id]
      ),
    'PENDING verification submission already exists'
  );
  await actAsService();
  assert.equal(
    (await rows(`select 1 from public.verification_submissions where profile_id = $1`, [profileV.id])).length,
    1
  );
});

test('21 · verification: invalid verification states are rejected', async () => {
  await actAs(userV.id);
  for (const bad of ['APPROVED', 'VERIFIED', 'REJECTED', 'pending', '']) {
    await expectFailure(
      () =>
        rows(
          `insert into public.verification_submissions (profile_id, storage_path, status)
           values ($1, 'student-ids/v/invalid.jpg', $2)`,
          [profileV.id, bad]
        ),
      'must be created in state PENDING'
    );
  }
  await actAsService();
  assert.equal(
    (await rows(`select 1 from public.verification_submissions where profile_id = $1`, [profileV.id])).length,
    1
  );
});

test('22 · verification: a normal user cannot mark themselves VERIFIED or touch reviewer info', async () => {
  await actAs(userV.id);

  // `authenticated` holds no UPDATE/DELETE grant at all: every mutation path
  // fails with permission denied before RLS is even reached.
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions set status = 'VERIFIED' where id = $1`,
        [submissionV1.id]
      ),
    'permission denied'
  );
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions set reviewer_id = $1 where id = $2`,
        [userStaff.id, submissionV1.id]
      ),
    'permission denied'
  );
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions
         set status = 'REJECTED', reviewer_id = $1, rejection_reason = 'self-reject'
         where id = $2`,
        [userStaff.id, submissionV1.id]
      ),
    'permission denied'
  );
  await expectFailure(
    () => rows(`delete from public.verification_submissions where id = $1`, [submissionV1.id]),
    'permission denied'
  );

  // The submission is untouched.
  const sub = await one(
    `select status, reviewer_id, reviewed_at from public.verification_submissions where id = $1`,
    [submissionV1.id]
  );
  assert.equal(sub.status, 'PENDING');
  assert.equal(sub.reviewer_id, null);
  assert.equal(sub.reviewed_at, null);
});

test('23 · verification: normal users cannot create, modify, or see review history', async () => {
  await actAs(userV.id);

  // No INSERT/UPDATE/DELETE privilege exists for `authenticated` on the audit
  // table: faking or tampering with review records is impossible.
  await expectFailure(
    () =>
      rows(
        `insert into public.verification_reviews (submission_id, reviewer_id, decision, rejection_reason)
         values ($1, $2, 'VERIFIED', null)`,
        [submissionV1.id, userStaff.id]
      ),
    'permission denied'
  );
  await expectFailure(
    () =>
      rows(
        `update public.verification_reviews set decision = 'REJECTED' where submission_id = $1`,
        [submissionV1.id]
      ),
    'permission denied'
  );
  await expectFailure(
    () =>
      rows(
        `delete from public.verification_reviews where submission_id = $1`,
        [submissionV1.id]
      ),
    'permission denied'
  );

  // SELECT is granted only so RLS policies can evaluate staff membership;
  // RLS hides every audit row from non-staff.
  assert.equal((await rows(`select * from public.verification_reviews`)).length, 0);
});

test('24 · verification: staff REJECTED decision requires reviewer + reason, is server-timestamped, auto-audited', async () => {
  await actAsService();

  // A decision without a reviewer is rejected.
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions
         set status = 'REJECTED', rejection_reason = 'Nobody decided this'
         where id = $1`,
        [submissionV1.id]
      ),
    'decision requires a reviewer'
  );

  // A REJECTED decision without a rejection reason is rejected…
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions
         set status = 'REJECTED', reviewer_id = $1, rejection_reason = null
         where id = $2`,
        [userStaff.id, submissionV1.id]
      ),
    'rejection reason'
  );
  // …as is an untrimmed one…
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions
         set status = 'REJECTED', reviewer_id = $1, rejection_reason = '  Blurry photo  '
         where id = $2`,
        [userStaff.id, submissionV1.id]
      ),
    'rejection reason'
  );
  // …and one from a reviewer who is not registered staff.
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions
         set status = 'REJECTED', reviewer_id = $1, rejection_reason = 'Not staff'
         where id = $2`,
        [userW.id, submissionV1.id]
      ),
    'verification_submissions_reviewer_id_fkey'
  );

  // The valid decision goes through; reviewed_at is server-assigned even when
  // the caller tries to supply a fake one.
  const decided = await one(
    `update public.verification_submissions
     set status = 'REJECTED', reviewer_id = $1, rejection_reason = 'Document unreadable',
         reviewed_at = '2000-01-01T00:00:00Z'::timestamptz
     where id = $2
     returning status, reviewer_id, reviewed_at, rejection_reason, submitted_at, created_at, updated_at`,
    [userStaff.id, submissionV1.id]
  );
  assert.equal(decided.status, 'REJECTED');
  assert.equal(decided.reviewer_id, userStaff.id);
  assert.equal(decided.rejection_reason, 'Document unreadable');
  assert.ok(
    decided.reviewed_at.getTime() > new Date('2020-01-01T00:00:00Z').getTime(),
    'reviewed_at must be server-assigned, not the client-supplied value'
  );
  assert.ok(decided.updated_at.getTime() > decided.created_at.getTime());

  // The decision produced exactly one audit record with the same facts.
  const audit = await rows(
    `select * from public.verification_reviews where submission_id = $1`,
    [submissionV1.id]
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reviewer_id, userStaff.id);
  assert.equal(audit[0].decision, 'REJECTED');
  assert.equal(audit[0].rejection_reason, 'Document unreadable');
  assert.ok(audit[0].created_at instanceof Date);

  // The owner can still read their rejected submission and its reason.
  await actAs(userV.id);
  const own = await one(`select status, rejection_reason from public.verification_submissions where id = $1`, [
    submissionV1.id,
  ]);
  assert.equal(own.status, 'REJECTED');
  assert.equal(own.rejection_reason, 'Document unreadable');
});

test('25 · verification: decided submissions and audit records are immutable', async () => {
  await actAsService();

  // No transition out of a decided state (resubmission is a NEW row instead).
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions set status = 'PENDING' where id = $1`,
        [submissionV1.id]
      ),
    'illegal verification status transition: REJECTED -> PENDING'
  );
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions set status = 'VERIFIED' where id = $1`,
        [submissionV1.id]
      ),
    'illegal verification status transition: REJECTED -> VERIFIED'
  );

  // Review records are append-only: UPDATE and TRUNCATE are blocked even for
  // the service role.
  await expectFailure(
    () =>
      rows(
        `update public.verification_reviews set decision = 'VERIFIED' where submission_id = $1`,
        [submissionV1.id]
      ),
    'append-only'
  );
  await expectFailure(() => exec(`truncate table public.verification_reviews`), 'append-only');

  // Submission facts are immutable: submission time, creation time, profile,
  // document reference, and review fields cannot be rewritten.
  const unchanged = await one(
    `update public.verification_submissions
     set submitted_at = submitted_at - interval '1 hour',
         created_at = '2000-01-01T00:00:00Z'::timestamptz
     where id = $1
     returning submitted_at, created_at`,
    [submissionV1.id]
  );
  const before = await one(`select submitted_at, created_at from public.verification_submissions where id = $1`, [
    submissionV1.id,
  ]);
  assert.equal(unchanged.submitted_at.getTime(), before.submitted_at.getTime());
  assert.equal(unchanged.created_at.getTime(), before.created_at.getTime());

  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions set storage_path = 'student-ids/rewritten.jpg' where id = $1`,
        [submissionV1.id]
      ),
    'document reference is immutable'
  );
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions set profile_id = $1 where id = $2`,
        [profileW.id, submissionV1.id]
      ),
    'cannot change profile'
  );
  await expectFailure(
    () =>
      rows(
        `update public.verification_submissions set reviewer_id = $1 where id = $2`,
        [userW.id, submissionV1.id]
      ),
    'review fields may only change as part of a status decision'
  );
});

test('26 · verification: resubmission after rejection creates a new auditable submission', async () => {
  // REJECTED -> PENDING happens through a NEW submission row; the rejected
  // history row stays untouched.
  await actAs(userV.id);
  const sub = await one(
    `insert into public.verification_submissions (profile_id, storage_path)
     values ($1, 'student-ids/v/submission-2.jpg')
     returning id, status, submitted_at`,
    [profileV.id]
  );
  submissionV2 = sub;
  assert.equal(sub.status, 'PENDING');
  assert.ok(sub.submitted_at.getTime() > submissionV1.submitted_at.getTime());

  // Both the historical REJECTED row and the new PENDING row are readable.
  const history = await rows(
    `select status from public.verification_submissions where profile_id = $1 order by submitted_at`,
    [profileV.id]
  );
  assert.deepEqual(history.map((r) => r.status), ['REJECTED', 'PENDING']);

  // The derived current state (latest submission) follows the new submission.
  const state = await one(
    `select status from public.verification_submissions
     where profile_id = $1 order by submitted_at desc limit 1`,
    [profileV.id]
  );
  assert.equal(state.status, 'PENDING');
});

test('27 · verification: VERIFIED decision is audited, terminal, and blocks further submissions', async () => {
  await actAsService();
  const decided = await one(
    `update public.verification_submissions
     set status = 'VERIFIED', reviewer_id = $1, rejection_reason = 'must be dropped'
     where id = $2
     returning status, reviewer_id, reviewed_at, rejection_reason`,
    [userStaff.id, submissionV2.id]
  );
  assert.equal(decided.status, 'VERIFIED');
  assert.equal(decided.reviewer_id, userStaff.id);
  assert.ok(decided.reviewed_at instanceof Date);
  assert.equal(decided.rejection_reason, null, 'VERIFIED must not carry a rejection reason');

  const audit = await rows(
    `select decision, rejection_reason from public.verification_reviews where submission_id = $1`,
    [submissionV2.id]
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].decision, 'VERIFIED');
  assert.equal(audit[0].rejection_reason, null);

  // Current derived state (latest submission) is VERIFIED.
  const state = await one(
    `select status from public.verification_submissions
     where profile_id = $1 order by submitted_at desc limit 1`,
    [profileV.id]
  );
  assert.equal(state.status, 'VERIFIED');

  // VERIFIED is terminal: the verified user cannot submit again.
  await actAs(userV.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.verification_submissions (profile_id, storage_path)
         values ($1, 'student-ids/v/submission-3.jpg')`,
        [profileV.id]
      ),
    'already VERIFIED'
  );
});

test('28 · verification: staff can read the review queue and audit trail; other users cannot', async () => {
  await actAs(userStaff.id);

  // Staff sees submissions they do not own (the review queue)…
  const queue = await rows(`select id, profile_id, status from public.verification_submissions`);
  assert.ok(queue.length >= 2, 'staff must see other users’ submissions');
  assert.ok(queue.every((r) => r.profile_id !== null));
  // …the full audit trail…
  const audit = await rows(`select * from public.verification_reviews`);
  assert.equal(audit.length, 2);
  // …and their own staff row (non-staff see none).
  assert.equal((await rows(`select * from public.staff_admins`)).length, 1);

  await actAs(userW.id);
  assert.equal((await rows(`select * from public.verification_submissions`)).length, 0);
  assert.equal((await rows(`select * from public.verification_reviews`)).length, 0);
  assert.equal((await rows(`select * from public.staff_admins`)).length, 0);
});

test('29 · verification: status is self-only — arbitrary-profile status cannot be obtained', async () => {
  // (a) A user CAN obtain their OWN verification status: the owner-only RLS
  // read of verification_submissions is the single supported path. (At this
  // point userV's latest submission is VERIFIED.)
  await actAs(userV.id);
  const own = await one(
    `select status from public.verification_submissions where profile_id = $1
     order by submitted_at desc limit 1`,
    [profileV.id]
  );
  assert.equal(own.status, 'VERIFIED');

  // A profile that never submitted sees no rows (equivalent of "no state").
  await actAs(userW.id);
  assert.equal(
    (await rows(
      `select status from public.verification_submissions where profile_id = $1`,
      [profileW.id]
    )).length,
    0
  );

  // (b) A user CANNOT obtain another user's verification status: RLS hides
  // the rows even when explicitly targeted…
  assert.equal(
    (await rows(
      `select status from public.verification_submissions where profile_id = $1`,
      [profileV.id]
    )).length,
    0
  );
  // …and the previously vulnerable SECURITY DEFINER status helper no longer
  // exists, so it cannot be abused for arbitrary-profile disclosure.
  await expectFailure(
    () => rows(`select public.current_verification_status($1)`, [profileV.id]),
    'does not exist'
  );

  // (c) Anonymous callers are denied outright.
  await actAs(null);
  await expectFailure(
    () => rows(`select * from public.verification_submissions`),
    'permission denied'
  );
  await expectFailure(
    () => rows(`select public.current_verification_status($1)`, [profileV.id]),
    'does not exist'
  );
});

test('30 · verification: foreign keys, cascades, and reviewer protection behave correctly', async () => {
  await actAsService();

  // A submission cannot reference a nonexistent profile.
  await expectFailure(
    () =>
      rows(
        `insert into public.verification_submissions (profile_id, storage_path)
         values ($1, 'student-ids/ghost/id.jpg')`,
        ['00000000-0000-0000-0000-000000000000']
      ),
    'verification_submissions_profile_id_fkey'
  );

  // An audit record cannot reference a nonexistent submission…
  await expectFailure(
    () =>
      rows(
        `insert into public.verification_reviews (submission_id, reviewer_id, decision, rejection_reason)
         values ($1, $2, 'REJECTED', 'Ghost')`,
        ['00000000-0000-0000-0000-000000000000', userStaff.id]
      ),
    'verification_reviews_submission_id_fkey'
  );
  // …and a manual audit insert cannot carry an invalid decision.
  await expectFailure(
    () =>
      rows(
        `insert into public.verification_reviews (submission_id, reviewer_id, decision, rejection_reason)
         values ($1, $2, 'PENDING', null)`,
        [submissionV1.id, userStaff.id]
      ),
    'verification_reviews_decision_valid'
  );

  // Account deletion cascades through profile -> submissions -> audit records.
  const userZ = await one(`insert into auth.users (email) values ('z@example.test') returning id`);
  await actAs(userZ.id);
  const profileZ = await insertProfileAsOwner(userZ.id);
  const subZ = await one(
    `insert into public.verification_submissions (profile_id, storage_path)
     values ($1, 'student-ids/z/submission-1.jpg')
     returning id`,
    [profileZ.id]
  );
  await actAsService();
  await rows(
    `update public.verification_submissions
     set status = 'REJECTED', reviewer_id = $1, rejection_reason = 'Test rejection'
     where id = $2`,
    [userStaff.id, subZ.id]
  );
  assert.equal((await rows(`select 1 from public.verification_reviews where submission_id = $1`, [subZ.id])).length, 1);

  await rows(`delete from auth.users where id = $1`, [userZ.id]);
  assert.equal((await rows(`select 1 from public.verification_submissions where id = $1`, [subZ.id])).length, 0);
  assert.equal((await rows(`select 1 from public.verification_reviews where submission_id = $1`, [subZ.id])).length, 0);

  // A reviewer with recorded decisions cannot be hard-deleted (audit
  // integrity): the RESTRICT foreign keys block the staff row removal.
  await expectFailure(
    () => rows(`delete from auth.users where id = $1`, [userStaff.id]),
    'violates foreign key constraint'
  );
  assert.equal(
    (await rows(`select 1 from public.staff_admins where auth_user_id = $1`, [userStaff.id])).length,
    1
  );
});

test('31 · verification: anonymous clients have no access to verification tables', async () => {
  await actAs(null);
  await expectFailure(() => rows(`select * from public.verification_submissions`), 'permission denied');
  await expectFailure(() => rows(`select * from public.verification_reviews`), 'permission denied');
  await expectFailure(() => rows(`select * from public.staff_admins`), 'permission denied');
});

// ============================================================================
// Storage slices — private buckets and object policies
// ============================================================================

test('32 · storage: verification and profile-photo buckets are private with photo/document limits', async () => {
  await actAsService();
  const buckets = await rows(`select * from storage.buckets order by id`);
  assert.deepEqual(buckets.map((b) => b.id), ['profile-photos', 'verification-documents']);

  for (const bucket of buckets) {
    assert.equal(bucket.public, false, `${bucket.id} must be private`);
    assert.equal(bucket.file_size_limit, 10485760, `${bucket.id} caps uploads at 10 MB`);
  }

  const photos = buckets.find((b) => b.id === 'profile-photos');
  assert.deepEqual(photos.allowed_mime_types.sort(), ['image/jpeg', 'image/png', 'image/webp']);

  const documents = buckets.find((b) => b.id === 'verification-documents');
  assert.deepEqual(documents.allowed_mime_types.sort(), [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
  ]);
});

test('33 · storage: profile photos are owner-scoped (upload into own path only)', async () => {
  // The owner may upload into their own auth-uid directory of profile-photos…
  await actAs(userA.id);
  await rows(
    `insert into storage.objects (bucket_id, name) values ('profile-photos', $1)`,
    [`${userA.id}/object-a.png`]
  );

  // …but never into another user's directory.
  await expectFailure(
    () =>
      rows(
        `insert into storage.objects (bucket_id, name) values ('profile-photos', $1)`,
        [`${userB.id}/object-b.png`]
      ),
    'new row violates row-level security policy'
  );

  // …and never into another user's directory of the verification bucket
  // either (its owner policy is identically path-scoped).
  await expectFailure(
    () =>
      rows(
        `insert into storage.objects (bucket_id, name) values ('verification-documents', $1)`,
        [`${userB.id}/object-b.png`]
      ),
    'new row violates row-level security policy'
  );
});

test('34 · storage: profile photos are readable only by their owner', async () => {
  // The owner sees their own object…
  await actAs(userA.id);
  const own = await rows(`select name from storage.objects where bucket_id = 'profile-photos'`);
  assert.equal(own.length, 1);
  assert.ok(own[0].name.startsWith(`${userA.id}/`));

  // …another authenticated user sees none of it (and none of their own here)…
  await actAs(userB.id);
  assert.equal(
    (await rows(`select name from storage.objects where bucket_id = 'profile-photos'`)).length,
    0
  );

  // …and anonymous callers are denied by default: RLS is enabled and `anon`
  // holds no policy, so the query returns nothing (and writes are denied).
  await actAs(null);
  assert.equal(
    (await rows(`select name from storage.objects where bucket_id = 'profile-photos'`)).length,
    0
  );
  await expectFailure(
    () =>
      rows(
        `insert into storage.objects (bucket_id, name) values ('profile-photos', 'anon/x.png')`
      ),
    'row-level security'
  );
});

test('35 · storage: profile photo objects have no update/delete path for normal users', async () => {
  await actAs(userA.id);
  const ownName = (await rows(`select name from storage.objects where bucket_id = 'profile-photos'`))[0].name;

  // No UPDATE/DELETE policies exist, so RLS filters every row away: the
  // statements silently touch zero rows (and are never attempted by the app —
  // object removal goes through the backend's service role).
  assert.equal(
    await touched(
      `update storage.objects set name = $1 where name = $2 returning 1`,
      [`${userA.id}/moved.png`, ownName]
    ),
    0
  );
  assert.equal(
    await touched(`delete from storage.objects where name = $1 returning 1`, [ownName]),
    0
  );
  // The object is untouched.
  assert.equal(
    (await rows(`select name from storage.objects where bucket_id = 'profile-photos'`))[0].name,
    ownName
  );
});

test('36 · storage: profile photo rows and objects are linked but independently secured', async () => {
  // Photo rows remain owner-scoped in the database (already covered), and a
  // row can be inserted only with a unique object path — enforcing one row
  // per Storage object.
  await actAs(userA.id);
  const objectName = (
    await rows(`select name from storage.objects where bucket_id = 'profile-photos'`)
  )[0].name;

  await rows(
    `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
     values ($1, $2, 2, false)`,
    [profileA.id, objectName]
  );

  await expectFailure(
    () =>
      rows(
        `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
         values ($1, $2, 3, false)`,
        [profileA.id, objectName]
      ),
    'profile_photos_storage_path_key'
  );
});

// ============================================================================
// Discovery slice tests
// ============================================================================

// Discovery fixtures are created inside the first discovery test (service
// context) and shared through module-scoped variables, so tests never depend
// on module-evaluation order or leave stray roles behind.
let discUserV, discUserPending, discUserRejected, discUserNone;
let discProfileV, discProfilePending, discProfileRejected, discProfileNone;

test('37 · discovery: is_profile_verified returns true for VERIFIED, false otherwise', async () => {
  await actAsService();
  discUserV = await one(`insert into auth.users (email) values ('disc-v@example.test') returning id`);
  discUserPending = await one(`insert into auth.users (email) values ('disc-pending@example.test') returning id`);
  discUserRejected = await one(`insert into auth.users (email) values ('disc-rejected@example.test') returning id`);
  discUserNone = await one(`insert into auth.users (email) values ('disc-none@example.test') returning id`);

  discProfileV = await one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, 'DiscV', current_date - interval '20 years', $2,
             'Computer Science', 2, 'woman', 'everyone', 'Discovery verified')
     returning id`,
    [discUserV.id, university.id]
  );
  discProfilePending = await one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, 'DiscP', current_date - interval '20 years', $2,
             'Computer Science', 2, 'woman', 'everyone', 'Discovery pending')
     returning id`,
    [discUserPending.id, university.id]
  );
  discProfileRejected = await one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, 'DiscR', current_date - interval '20 years', $2,
             'Computer Science', 2, 'woman', 'everyone', 'Discovery rejected')
     returning id`,
    [discUserRejected.id, university.id]
  );
  discProfileNone = await one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, 'DiscN', current_date - interval '20 years', $2,
             'Computer Science', 2, 'woman', 'everyone', 'Discovery no-sub')
     returning id`,
    [discUserNone.id, university.id]
  );

  const subDiscV = await one(
    `insert into public.verification_submissions (profile_id, storage_path)
     values ($1, 'student-ids/disc/v.jpg') returning id`,
    [discProfileV.id]
  );
  await one(
    `update public.verification_submissions
     set status = 'VERIFIED', reviewer_id = $1
     where id = $2 returning id`,
    [userStaff.id, subDiscV.id]
  );
  await one(
    `insert into public.verification_submissions (profile_id, storage_path)
     values ($1, 'student-ids/disc/pending.jpg') returning id`,
    [discProfilePending.id]
  );
  const subDiscRejected = await one(
    `insert into public.verification_submissions (profile_id, storage_path)
     values ($1, 'student-ids/disc/rejected.jpg') returning id`,
    [discProfileRejected.id]
  );
  await one(
    `update public.verification_submissions
     set status = 'REJECTED', reviewer_id = $1, rejection_reason = 'Disc test rejection'
     where id = $2 returning id`,
    [userStaff.id, subDiscRejected.id]
  );
  await one(
    `insert into public.profile_photos (profile_id, storage_path, position, is_primary)
     values ($1, 'disc/v/photo-1.jpg', 1, true) returning id`,
    [discProfileV.id]
  );

  // Authenticated (non-service) caller may call the helper.
  await actAs(discUserNone.id);
  assert.equal((await rows(`select public.is_profile_verified($1) as v`, [profileV.id]))[0].v, true);
  assert.equal((await rows(`select public.is_profile_verified($1) as v`, [discProfileV.id]))[0].v, true);
  assert.equal((await rows(`select public.is_profile_verified($1) as v`, [discProfilePending.id]))[0].v, false);
  assert.equal((await rows(`select public.is_profile_verified($1) as v`, [discProfileRejected.id]))[0].v, false);
  assert.equal(
    (await rows(`select public.is_profile_verified('00000000-0000-0000-0000-000000000000') as v`))[0].v,
    false
  );
  assert.equal((await rows(`select public.is_profile_verified($1) as v`, [discProfileNone.id]))[0].v, false);
});

test('38 · discovery: verified users can SELECT other verified profiles', async () => {
  await actAs(userV.id); // VERIFIED viewer
  const visible = await rows(`select id, first_name from public.profiles`);
  const ids = visible.map((r) => String(r.id));
  // Own profile is visible (owner policy).
  assert.ok(ids.includes(String(profileV.id)));
  // Another verified profile is visible (new cross-read policy).
  assert.ok(ids.includes(String(discProfileV.id)));
  // Unverified profiles are NOT visible.
  assert.equal(ids.includes(String(discProfilePending.id)), false);
  assert.equal(ids.includes(String(discProfileRejected.id)), false);
  assert.equal(ids.includes(String(discProfileNone.id)), false);
  assert.equal(ids.includes(String(profileW.id)), false);
});

test('39 · discovery: unverified users cannot cross-read profiles', async () => {
  // discUserNone has no verification submissions → unverified.
  await actAs(discUserNone.id);
  const visible = await rows(`select id from public.profiles`);
  const ids = visible.map((r) => String(r.id));
  assert.deepEqual(ids, [String(discProfileNone.id)]);

  // A PENDING user also cannot cross-read.
  await actAs(discUserPending.id);
  const pendingVisible = await rows(`select id from public.profiles`);
  const pendingIds = pendingVisible.map((r) => String(r.id));
  assert.deepEqual(pendingIds, [String(discProfilePending.id)]);
});

test('40 · discovery: verified users cannot read unverified profiles', async () => {
  await actAs(userV.id); // VERIFIED viewer
  // PENDING profile is not visible.
  assert.equal(
    (await rows(`select 1 from public.profiles where id = $1`, [discProfilePending.id])).length,
    0
  );
  // REJECTED profile is not visible.
  assert.equal(
    (await rows(`select 1 from public.profiles where id = $1`, [discProfileRejected.id])).length,
    0
  );
  // No-submission profile is not visible.
  assert.equal(
    (await rows(`select 1 from public.profiles where id = $1`, [discProfileNone.id])).length,
    0
  );
  // userW (no submissions) is not visible.
  assert.equal(
    (await rows(`select 1 from public.profiles where id = $1`, [profileW.id])).length,
    0
  );
});

test('41 · discovery: verified users can read discoverable profile photos', async () => {
  // userV (VERIFIED) reads the photo belonging to discProfileV (VERIFIED).
  await actAs(userV.id);
  const photos = await rows(
    `select storage_path, is_primary from public.profile_photos where profile_id = $1`,
    [discProfileV.id]
  );
  assert.equal(photos.length, 1);
  assert.equal(photos[0].storage_path, 'disc/v/photo-1.jpg');
  assert.equal(photos[0].is_primary, true);

  // An unverified user cannot read the same photo.
  await actAs(discUserNone.id);
  assert.equal(
    (await rows(`select 1 from public.profile_photos where profile_id = $1`, [discProfileV.id])).length,
    0
  );
});

test('42 · discovery: existing owner-only access still works for unverified owners', async () => {
  // userW (no submissions, unverified) still reads their own profile.
  await actAs(userW.id);
  assert.equal(
    (await rows(`select 1 from public.profiles where id = $1`, [profileW.id])).length,
    1
  );
  // But cannot read another verified user's profile.
  assert.equal(
    (await rows(`select 1 from public.profiles where id = $1`, [discProfileV.id])).length,
    0
  );
  // Own photos still visible.
  assert.equal(
    (await rows(`select 1 from public.profile_photos where profile_id = $1`, [profileW.id])).length,
    0
  );
  // Own interests still visible.
  assert.equal(
    (await rows(`select 1 from public.profile_interests where profile_id = $1`, [profileW.id])).length,
    0
  );
});

// ============================================================================
// Likes/passes/matches slice tests (Phase 6)
// ============================================================================

// Phase 6 fixtures are created inside the first dating test (service context)
// and shared through module-scoped variables, mirroring the discovery pattern.
let likeUserA, likeUserB, likeProfileA, likeProfileB;
let matchId; // the A<->B match used by the visibility tests

async function insertVerifiedUserFixture(prefix, index) {
  const user = await one(`insert into auth.users (email) values ($1) returning id`, [
    `${prefix}-${index}@example.test`,
  ]);
  const profile = await one(
    `insert into public.profiles ${PROFILE_COLUMNS}
     values ($1, $2, current_date - interval '20 years', $3,
             'Computer Science', 2, 'woman', 'everyone', 'Dating fixture')
     returning id`,
    [user.id, `Dating${index}`, university.id]
  );
  const sub = await one(
    `insert into public.verification_submissions (profile_id, storage_path)
     values ($1, $2) returning id`,
    [profile.id, `student-ids/dating/${index}.jpg`]
  );
  await one(
    `update public.verification_submissions
     set status = 'VERIFIED', reviewer_id = $1 where id = $2 returning id`,
    [userStaff.id, sub.id]
  );
  return { user, profile };
}

test('43 · dating: verified viewer can record an action for their own profile', async () => {
  await actAsService();
  ({ user: likeUserA, profile: likeProfileA } = await insertVerifiedUserFixture('dating-a', 'A'));
  ({ user: likeUserB, profile: likeProfileB } = await insertVerifiedUserFixture('dating-b', 'B'));

  await actAs(likeUserA.id);
  const action = await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id, action_type, created_at`,
    [likeProfileA.id, likeProfileB.id, oppId]
  );
  assert.equal(action.action_type, 'LIKE');
  assert.ok(action.created_at instanceof Date);

  // Own OUTGOING actions are readable back.
  const mine = await rows(`select id from public.dating_actions`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, action.id);
});

test('44 · dating: self-actions are rejected by the CHECK constraint', async () => {
  await actAs(likeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $1, 'LIKE', $2)`,
        [likeProfileA.id, oppId]
      ),
    'dating_actions_no_self_action'
  );
});

test('45 · dating: exactly one action per actor/target/opportunity; the pair may act in different opportunities', async () => {
  await actAs(likeUserA.id);
  // Duplicate LIKE on the SAME opportunity…
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'LIKE', $3)`,
        [likeProfileA.id, likeProfileB.id, oppId]
      ),
    'dating_actions_actor_target_opportunity_unique'
  );
  // …PASS on the same pair + opportunity is the same unique slot — rejected.
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'PASS', $3)`,
        [likeProfileA.id, likeProfileB.id, oppId]
      ),
    'dating_actions_actor_target_opportunity_unique'
  );
  // The SAME pair may act independently through a DIFFERENT opportunity.
  await actAsService();
  const otherOpp = await insertPublishedOpportunity('Fixture Event Two');
  await actAs(likeUserA.id);
  const second = await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [likeProfileA.id, likeProfileB.id, otherOpp.id]
  );
  assert.ok(second.id);
});

test('46 · dating: action_type is restricted to LIKE/PASS', async () => {
  await actAs(likeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'MAYBE', $3)`,
        [likeProfileA.id, likeProfileB.id, oppId]
      ),
    'dating_actions_action_type_check'
  );
});

test('47 · dating: a client cannot spoof the actor (actor_profile_id must be their own)', async () => {
  // likeUserB tries to create an action FROM likeProfileA — the INSERT
  // policy requires actor_profile_id to resolve to auth.uid().
  await actAs(likeUserB.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'LIKE', $3)`,
        [likeProfileA.id, likeProfileB.id, oppId]
      ),
    'row-level security'
  );
  // Nothing was created for likeProfileA.
  await actAsService();
  assert.equal(
    (await rows(`select 1 from public.dating_actions where actor_profile_id = $1`, [likeProfileA.id])).length,
    2 // likeUserA's genuine actions from test 43 + the second-opportunity action in test 45
  );
});

test('48 · dating: an unverified viewer cannot record actions', async () => {
  await actAs(userW.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'LIKE', $3)`,
        [profileW.id, likeProfileA.id, oppId]
      ),
    'row-level security'
  );
});

test('49 · dating: an unverified target cannot be acted on', async () => {
  await actAs(likeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'LIKE', $3)`,
        [likeProfileA.id, discProfilePending.id, oppId]
      ),
    'row-level security'
  );
});

test('50 · dating: anonymous clients have no access to dating_actions', async () => {
  await actAs(null);
  await expectFailure(() => rows(`select * from public.dating_actions`), 'permission denied');
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'LIKE', $3)`,
        [likeProfileA.id, likeProfileB.id, oppId]
      ),
    'permission denied'
  );
});

test('51 · dating: incoming actions are never visible (no "who liked you")', async () => {
  // likeUserB records their own action on likeProfileA.
  await actAs(likeUserB.id);
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [likeProfileB.id, likeProfileA.id, oppId]
  );

  // likeUserA cannot see the incoming LIKE targeting them…
  await actAs(likeUserA.id);
  assert.equal(
    (await rows(`select 1 from public.dating_actions where actor_profile_id = $1`, [likeProfileB.id])).length,
    0
  );
  // …only their own outgoing actions.
  const mine = await rows(`select actor_profile_id from public.dating_actions`);
  assert.equal(mine.length, 2); // two own opportunities from test 43/45
  assert.ok(mine.every((m) => m.actor_profile_id === likeProfileA.id));
});

test('52 · dating: actions are immutable for normal users (no UPDATE/DELETE grant)', async () => {
  await actAs(likeUserA.id);
  await expectFailure(
    () => rows(`update public.dating_actions set action_type = 'PASS' where actor_profile_id = $1`, [likeProfileA.id]),
    'permission denied'
  );
  await expectFailure(
    () => rows(`delete from public.dating_actions where actor_profile_id = $1`, [likeProfileA.id]),
    'permission denied'
  );
});

test('53 · matches: canonical pair ordering, per-opportunity uniqueness, no self-match, server-only writes', async () => {
  // Normal users hold no INSERT grant — matches are created only by the
  // backend's service-role atomic operation.
  await actAs(likeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id, opportunity_id) values ($1, $2, $3)`,
        [likeProfileA.id, likeProfileB.id, oppId]
      ),
    'permission denied'
  );

  await actAsService();
  // Canonical ordering is enforced (user_a_id must be the smaller uuid).
  const [smaller, larger] = [likeProfileA.id, likeProfileB.id].sort();
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id, opportunity_id) values ($1, $2, $3)`,
        [larger, smaller, oppId]
      ),
    'matches_canonical_pair_order'
  );
  // A profile cannot match itself.
  await expectFailure(
    () => rows(`insert into public.matches (user_a_id, user_b_id, opportunity_id) values ($1, $1, $2)`, [likeProfileA.id, oppId]),
    'matches_canonical_pair_order'
  );
  // The canonical insert succeeds…
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id, opportunity_id) values ($1, $2, $3) returning id, created_at`,
    [smaller, larger, oppId]
  );
  matchId = match.id;
  // …and the (pair, opportunity) is unique — a second row for the same pair
  // and opportunity is impossible.
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id, opportunity_id) values ($1, $2, $3)`,
        [smaller, larger, oppId]
      ),
    'matches_pair_opportunity_unique'
  );
  // …but the SAME pair may match independently through another opportunity.
  const otherOpp = await insertPublishedOpportunity('Fixture Event Three');
  const secondMatch = await one(
    `insert into public.matches (user_a_id, user_b_id, opportunity_id) values ($1, $2, $3) returning id`,
    [smaller, larger, otherOpp.id]
  );
  assert.ok(secondMatch.id);
  // Remove the second contextual match so the participant-visibility test
  // below sees exactly the one active match.
  await one(`delete from public.matches where id = $1 returning 1`, [secondMatch.id]);
  // unmatched_at cannot precede created_at.
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id, opportunity_id, created_at, unmatched_at)
         values ($1, $2, $3, now(), now() - interval '1 hour')`,
        [smaller, larger, oppId]
      ),
    'matches_unmatch_after_creation'
  );

  // Service-role unmatch (soft) works and respects the consistency check;
  // the row is retained. Then the match is restored for the visibility tests.
  await one(`update public.matches set unmatched_at = now() where id = $1 returning 1`, [matchId]);
  await one(`update public.matches set unmatched_at = null where id = $1 returning 1`, [matchId]);
});

test('54 · matches: participant-only visibility (nonparticipants and anon see nothing)', async () => {
  await actAs(likeUserA.id);
  assert.equal((await rows(`select id from public.matches`)).length, 1);
  await actAs(likeUserB.id);
  assert.equal((await rows(`select id from public.matches`)).length, 1);

  // A nonparticipant (verified or not) sees no rows — no existence leak.
  await actAs(userV.id);
  assert.equal((await rows(`select id from public.matches`)).length, 0);
  await actAs(userW.id);
  assert.equal((await rows(`select id from public.matches`)).length, 0);

  await actAs(null);
  await expectFailure(() => rows(`select * from public.matches`), 'permission denied');
});

test('55 · matches: deleting a profile cascades its actions and matches away', async () => {
  await actAsService();
  const { user: userCasc, profile: profileCasc } = await insertVerifiedUserFixture('dating-casc', 'C');

  // profileCasc acts on likeProfileA and matches with them (canonical insert).
  await actAs(userCasc.id);
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [profileCasc.id, likeProfileA.id, oppId]
  );
  await actAsService();
  const [smaller, larger] = [profileCasc.id, likeProfileA.id].sort();
  await one(
    `insert into public.matches (user_a_id, user_b_id, opportunity_id) values ($1, $2, $3) returning id`,
    [smaller, larger, oppId]
  );

  // Deleting the auth identity cascades profile → actions + matches.
  await rows(`delete from auth.users where id = $1`, [userCasc.id]);
  assert.equal(
    (await rows(`select 1 from public.dating_actions where actor_profile_id = $1 or target_profile_id = $1`, [profileCasc.id])).length,
    0
  );
  assert.equal(
    (await rows(`select 1 from public.matches where user_a_id = $1 or user_b_id = $1`, [profileCasc.id])).length,
    0
  );

  // The untouched pair's rows survive.
  assert.equal(
    (await rows(`select 1 from public.matches where id = $1`, [matchId])).length,
    1
  );
});

test('56 · dating: secondary indexes exist for both action directions', async () => {
  await actAsService();
  const indexes = await rows(`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'dating_actions'
  `);
  const names = indexes.map((i) => i.indexname);
  assert.ok(
    names.includes('dating_actions_target_profile_id_idx'),
    'expected an index on target_profile_id'
  );
  assert.ok(
    names.includes('dating_actions_actor_target_opportunity_unique'),
    'expected the unique (actor, target, opportunity) index'
  );
});



// ============================================================================
// Messaging slice tests (Phase 7)
// ============================================================================

// Phase 7 fixtures: three fresh verified users (A <-> B matched & active,
// A <-> C matched then unmatched) with their own matches, isolated from the
// dating tests' state.
let msgUserA, msgUserB, msgUserC, msgProfileA, msgProfileB, msgProfileC;
let msgMatchId; // active A<->B conversation
let msgUnmatchedMatchId; // A<->C, unmatched (conversation inaccessible)

test('57 · messaging: message bodies are trimmed, 1..2000 characters (CHECK)', async () => {
  await actAsService();
  ({ user: msgUserA, profile: msgProfileA } = await insertVerifiedUserFixture('messaging-a', 'M1'));
  ({ user: msgUserB, profile: msgProfileB } = await insertVerifiedUserFixture('messaging-b', 'M2'));
  ({ user: msgUserC, profile: msgProfileC } = await insertVerifiedUserFixture('messaging-c', 'M3'));

  const [smallerAB, largerAB] = [msgProfileA.id, msgProfileB.id].sort();
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smallerAB, largerAB]
  );
  msgMatchId = match.id;
  const [smallerAC, largerAC] = [msgProfileA.id, msgProfileC.id].sort();
  const unmatch = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smallerAC, largerAC]
  );
  msgUnmatchedMatchId = unmatch.id;
  await one(`update public.matches set unmatched_at = now() where id = $1 returning 1`, [
    msgUnmatchedMatchId,
  ]);

  // Valid insert (service role is the only writer).
  const message = await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'Hello there!') returning id, body, created_at`,
    [msgMatchId, msgProfileA.id]
  );
  assert.equal(message.body, 'Hello there!');

  // Untrimmed bodies are rejected (the backend trims before insert; the
  // database re-enforces the same rule).
  await expectFailure(
    () =>
      rows(
        `insert into public.messages (match_id, sender_profile_id, body)
         values ($1, $2, '  padded  ') returning id`,
        [msgMatchId, msgProfileA.id]
      ),
    'messages_body_valid'
  );
  // Empty / whitespace-only bodies are rejected.
  await expectFailure(
    () =>
      rows(
        `insert into public.messages (match_id, sender_profile_id, body)
         values ($1, $2, '') returning id`,
        [msgMatchId, msgProfileA.id]
      ),
    'messages_body_valid'
  );
  // 2000 characters are accepted, 2001 are not.
  await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, repeat('x', 2000)) returning id`,
    [msgMatchId, msgProfileA.id]
  );
  await expectFailure(
    () =>
      rows(
        `insert into public.messages (match_id, sender_profile_id, body)
         values ($1, $2, repeat('x', 2001)) returning id`,
        [msgMatchId, msgProfileA.id]
      ),
    'messages_body_valid'
  );
});

test('58 · messaging: only participants of an ACTIVE match can SELECT messages', async () => {
  await actAs(msgUserA.id);
  assert.equal((await rows(`select id from public.messages`)).length, 2);

  await actAs(msgUserB.id);
  assert.equal((await rows(`select id from public.messages`)).length, 2);

  // A verified nonparticipant sees nothing — no existence leak.
  await actAs(msgUserC.id);
  assert.equal((await rows(`select id from public.messages`)).length, 0);

  await actAs(null);
  await expectFailure(() => rows(`select * from public.messages`), 'permission denied');
});

test('59 · messaging: messages are immutable and unwritable for normal users', async () => {
  await actAs(msgUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.messages (match_id, sender_profile_id, body)
         values ($1, $2, 'client insert') returning id`,
        [msgMatchId, msgProfileA.id]
      ),
    'permission denied'
  );
  await expectFailure(
    () => rows(`update public.messages set body = 'edited' where match_id = $1`, [msgMatchId]),
    'permission denied'
  );
  await expectFailure(
    () => rows(`delete from public.messages where match_id = $1`, [msgMatchId]),
    'permission denied'
  );
  // Unread counters on matches are backend-managed too (no UPDATE grant).
  await expectFailure(
    () => rows(`update public.matches set user_a_unread_count = 0 where id = $1`, [msgMatchId]),
    'permission denied'
  );
});

test('60 · messaging: the send RPC increments only the recipient counter', async () => {
  await actAsService();
  // The canonical pair order is decided by uuid sort — resolve the sides.
  const sides = await one(
    `select user_a_id, user_b_id from public.matches where id = $1`,
    [msgMatchId]
  );
  const aIsUserA = sides.user_a_id === msgProfileA.id;
  const senderCol = aIsUserA ? 'user_a_unread_count' : 'user_b_unread_count';
  const recipientCol = aIsUserA ? 'user_b_unread_count' : 'user_a_unread_count';
  const counters = async () =>
    one(
      `select user_a_unread_count, user_b_unread_count
       from public.matches where id = $1`,
      [msgMatchId]
    );

  let c = await counters();
  assert.equal(c.user_a_unread_count, 0);
  assert.equal(c.user_b_unread_count, 0);

  // A sends to B: only B's counter ticks.
  const first = await one(
    `select * from public.send_conversation_message($1, $2, $3)`,
    [msgMatchId, msgProfileA.id, 'first message']
  );
  assert.equal(first.body, 'first message');
  assert.equal(first.sender_profile_id, msgProfileA.id);
  c = await counters();
  assert.equal(c[senderCol], 0);
  assert.equal(c[recipientCol], 1);

  // B replies: A's counter ticks instead.
  await one(`select * from public.send_conversation_message($1, $2, $3)`, [
    msgMatchId,
    msgProfileB.id,
    'second message',
  ]);
  c = await counters();
  assert.equal(c.user_a_unread_count, 1);
  assert.equal(c.user_b_unread_count, 1);

  // Mark-read zeroes only the caller's own counter (service-role update).
  await one(
    `update public.matches set ${senderCol} = 0 where id = $1 returning 1`,
    [msgMatchId]
  );
  c = await counters();
  assert.equal(c[senderCol], 0);
  assert.equal(c[recipientCol], 1);
});

test('61 · messaging: the send RPC is service-role only and enforces participants', async () => {
  // Normal users have no EXECUTE grant — sending goes through the backend.
  await actAs(msgUserA.id);
  await expectFailure(
    () =>
      rows(`select * from public.send_conversation_message($1, $2, $3)`, [
        msgMatchId,
        msgProfileA.id,
        'direct call',
      ]),
    'permission denied'
  );

  await actAsService();
  // A nonparticipant sender is refused (and inserts nothing).
  await expectFailure(
    () =>
      rows(`select * from public.send_conversation_message($1, $2, $3)`, [
        msgMatchId,
        msgProfileC.id,
        'not mine',
      ]),
    'not an active participant'
  );
  assert.equal(
    (await rows(`select id from public.messages where body = 'not mine'`)).length,
    0
  );
});

test('62 · messaging: unmatch makes the conversation inaccessible immediately', async () => {
  // Before unmatch, B (participant of the active match) sees the full history.
  await actAsService();
  const total = (
    await rows(`select id from public.messages where match_id = $1`, [msgMatchId])
  ).length;
  assert.ok(total >= 2, 'expected seeded history on the active match');

  await actAs(msgUserB.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [msgMatchId])).length,
    total
  );

  // The A<->C match is unmatched: C sees none of its (would-be) messages and
  // the RPC refuses to send there.
  await actAs(msgUserC.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [msgUnmatchedMatchId]))
      .length,
    0
  );
  await actAsService();
  await expectFailure(
    () =>
      rows(`select * from public.send_conversation_message($1, $2, $3)`, [
        msgUnmatchedMatchId,
        msgProfileC.id,
        'after unmatch',
      ]),
    'not an active participant'
  );

  // Now unmatch A<->B: both sides instantly lose read access.
  await one(`update public.matches set unmatched_at = now() where id = $1 returning 1`, [
    msgMatchId,
  ]);
  await actAs(msgUserA.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [msgMatchId])).length,
    0
  );
  await actAs(msgUserB.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [msgMatchId])).length,
    0
  );

  // The rows are retained, and the conversation comes back if the unmatch is
  // cleared (mirrors the Phase 6 restore in test 53).
  await actAsService();
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [msgMatchId])).length,
    total
  );
  await one(`update public.matches set unmatched_at = null where id = $1 returning 1`, [
    msgMatchId,
  ]);
  await actAs(msgUserB.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [msgMatchId])).length,
    total
  );
});

test('63 · messaging: keyset index exists; deleting a match cascades its messages', async () => {
  await actAsService();
  const indexes = await rows(`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'messages'
  `);
  assert.ok(
    indexes.map((i) => i.indexname).includes('messages_match_id_created_at_idx'),
    'expected the (match_id, created_at, id) keyset index'
  );

  // Deleting the match removes the conversation's messages with it.
  const [smaller, larger] = [msgProfileB.id, msgProfileC.id].sort();
  const temp = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smaller, larger]
  );
  await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'doomed') returning id`,
    [temp.id, msgProfileB.id]
  );
  await rows(`delete from public.matches where id = $1`, [temp.id]);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [temp.id])).length,
    0
  );
});

// ============================================================================
// Safety & moderation slice tests (Phase 8)
// ============================================================================

// Phase 8 fixtures: three fresh verified users (A, B, C). The index values
// must stay unique across the whole file — insertVerifiedUserFixture derives
// the verification storage_path from them.
let safeUserA, safeUserB, safeUserC, safeProfileA, safeProfileB, safeProfileC;

test('64 · safety: blocks schema invariants (self-block, uniqueness, index, cascade)', async () => {
  await actAsService();
  ({ user: safeUserA, profile: safeProfileA } = await insertVerifiedUserFixture('safety-a', 'S1'));
  ({ user: safeUserB, profile: safeProfileB } = await insertVerifiedUserFixture('safety-b', 'S2'));
  ({ user: safeUserC, profile: safeProfileC } = await insertVerifiedUserFixture('safety-c', 'S3'));

  // Self-blocks are rejected by the CHECK constraint.
  await expectFailure(
    () =>
      rows(
        `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $1)`,
        [safeProfileA.id]
      ),
    'blocks_no_self_block'
  );

  // The reverse-direction index exists (the unique constraint covers the
  // forward direction).
  const indexes = await rows(`
    select indexname from pg_indexes where schemaname = 'public' and tablename = 'blocks'
  `);
  assert.ok(
    indexes.map((i) => i.indexname).includes('blocks_blocked_profile_id_idx'),
    'expected the blocked_profile_id index'
  );

  // Deleting a profile cascades its blocks away (both directions).
  const userZ = await one(`insert into auth.users (email) values ('safety-z@example.test') returning id`);
  const profileZ = await insertProfileAsOwner(userZ.id);
  await actAsService();
  await rows(
    `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2)`,
    [safeProfileA.id, profileZ.id]
  );
  await rows(
    `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2)`,
    [profileZ.id, safeProfileB.id]
  );
  await rows(`delete from auth.users where id = $1`, [userZ.id]);
  assert.equal((await rows(`select 1 from public.blocks where blocked_profile_id = $1`, [profileZ.id])).length, 0);
  assert.equal((await rows(`select 1 from public.blocks where blocker_profile_id = $1`, [profileZ.id])).length, 0);
});

test('65 · safety: blocks RLS insert — own blocker, VERIFIED caller, VERIFIED target', async () => {
  // A verified blocker can block another verified profile…
  await actAs(safeUserA.id);
  const block = await one(
    `insert into public.blocks (blocker_profile_id, blocked_profile_id)
     values ($1, $2) returning id, blocker_profile_id, blocked_profile_id, created_at`,
    [safeProfileA.id, safeProfileB.id]
  );
  assert.equal(block.blocker_profile_id, safeProfileA.id);
  assert.ok(block.created_at instanceof Date);

  // …exactly once (duplicate insert is rejected by the unique constraint —
  // the backend translates this into an idempotent re-block).
  await expectFailure(
    () =>
      rows(
        `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2)`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'blocks_blocker_blocked_unique'
  );

  // A client cannot spoof the blocker: blocker_profile_id must resolve to the
  // caller's own profile.
  await actAs(safeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2)`,
        [safeProfileB.id, safeProfileC.id]
      ),
    'row-level security'
  );

  // An unverified caller cannot block at all (profileW has no submissions).
  await actAs(userW.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2)`,
        [profileW.id, safeProfileA.id]
      ),
    'row-level security'
  );

  // A verified caller cannot block an unverified profile.
  await actAs(safeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2)`,
        [safeProfileA.id, profileW.id]
      ),
    'row-level security'
  );

  // Self-block fails the CHECK regardless of role.
  await actAs(safeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $1)`,
        [safeProfileA.id]
      ),
    'blocks_no_self_block'
  );

  // Anonymous callers have no access at all.
  await actAs(null);
  await expectFailure(
    () =>
      rows(
        `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2)`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'permission denied'
  );
});

test('66 · safety: blocks are silent — only the blocker sees and removes their own rows', async () => {
  // The blocker sees exactly their outgoing block.
  await actAs(safeUserA.id);
  const mine = await rows(`select blocked_profile_id from public.blocks`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].blocked_profile_id, safeProfileB.id);

  // The blocked user sees NOTHING — no incoming rows, no existence leak.
  await actAs(safeUserB.id);
  assert.equal((await rows(`select 1 from public.blocks`)).length, 0);
  // …and cannot delete someone else's block (RLS filters every row away).
  assert.equal(
    await touched(`delete from public.blocks where blocked_profile_id = $1 returning 1`, [safeProfileA.id]),
    0
  );

  // Unrelated users see nothing.
  await actAs(safeUserC.id);
  assert.equal((await rows(`select 1 from public.blocks`)).length, 0);

  // Anonymous callers are denied outright.
  await actAs(null);
  await expectFailure(() => rows(`select 1 from public.blocks`), 'permission denied');

  // The blocker can remove (unblock) their own block…
  await actAs(safeUserA.id);
  assert.equal(
    await touched(`delete from public.blocks where blocked_profile_id = $1 returning 1`, [safeProfileB.id]),
    1
  );
  // …and re-blocking works afterwards (fully reversible).
  await one(
    `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2) returning id`,
    [safeProfileA.id, safeProfileB.id]
  );
});

test('67 · safety: reports — insert rules, validation, duplicates allowed', async () => {
  await actAsService();
  const before = (await rows(`select 1 from public.reports`)).length;

  // The reporter's INSERT ... RETURNING is refused: reports have deliberately
  // NO user SELECT policy (contents are admin-only), so even the brand-new
  // row cannot be read back by its reporter. Production inserts run through
  // the backend's service role, which bypasses RLS.
  await actAs(safeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
         values ($1, $2, 'harassment') returning id`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'row-level security'
  );

  // The same insert WITHOUT RETURNING goes through; status is born OPEN.
  await rows(
    `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
     values ($1, $2, 'harassment')`,
    [safeProfileA.id, safeProfileB.id]
  );

  // Duplicate reports are allowed (report volume is admin signal, not an
  // error) — the same pair, same reason, twice.
  await rows(
    `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
     values ($1, $2, 'harassment')`,
    [safeProfileA.id, safeProfileB.id]
  );
  await actAsService();
  const first = await one(
    `select status, detail, content_type, content_id from public.reports order by created_at limit 1`
  );
  assert.equal(first.status, 'OPEN');
  assert.equal(first.detail, null);
  assert.equal(first.content_type, null);
  assert.equal((await rows(`select 1 from public.reports`)).length, before + 2);

  // A client cannot spoof the reporter.
  await actAs(safeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
         values ($1, $2, 'spam')`,
        [safeProfileB.id, safeProfileC.id]
      ),
    'row-level security'
  );

  // Self-reports are rejected by the CHECK constraint.
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
         values ($1, $1, 'spam')`,
        [safeProfileA.id]
      ),
    'reports_no_self_report'
  );

  // An unverified caller cannot report.
  await actAs(userW.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
         values ($1, $2, 'spam')`,
        [profileW.id, safeProfileA.id]
      ),
    'row-level security'
  );

  // Reason categories are a fixed enum.
  await actAs(safeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
         values ($1, $2, 'because')`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'reports_reason_valid'
  );

  // Detail must be trimmed and at most 1000 characters (or null).
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason, detail)
         values ($1, $2, 'spam', '  padded  ')`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'reports_detail_valid'
  );
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason, detail)
         values ($1, $2, 'spam', repeat('x', 1001))`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'reports_detail_valid'
  );
  await rows(
    `insert into public.reports (reporter_profile_id, reported_profile_id, reason, detail)
     values ($1, $2, 'spam', repeat('x', 1000))`,
    [safeProfileA.id, safeProfileB.id]
  );

  // The content reference is nullable as a pair, with a fixed type set.
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason, content_type)
         values ($1, $2, 'spam', 'message')`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'reports_content_pair_valid'
  );
  await expectFailure(
    () =>
      rows(
        `insert into public.reports (reporter_profile_id, reported_profile_id, reason, content_type, content_id)
         values ($1, $2, 'spam', 'story', gen_random_uuid())`,
        [safeProfileA.id, safeProfileB.id]
      ),
    'reports_content_type_valid'
  );
  await rows(
    `insert into public.reports (reporter_profile_id, reported_profile_id, reason, detail, content_type, content_id)
     values ($1, $2, 'inappropriate_content', 'See this message', 'message', gen_random_uuid())`,
    [safeProfileA.id, safeProfileB.id]
  );
  await actAsService();
  const withContent = await one(`select content_id from public.reports where content_type = 'message' limit 1`);
  assert.ok(withContent.content_id);

  // The report target need only exist — an unverified target is reportable.
  await rows(
    `insert into public.reports (reporter_profile_id, reported_profile_id, reason)
     values ($1, $2, 'other')`,
    [safeProfileA.id, profileW.id]
  );
});

test('68 · safety: reports are admin-only — reporters and users cannot read or modify', async () => {
  // A reporter cannot read reports back — not even their own.
  await actAs(safeUserA.id);
  assert.equal((await rows(`select 1 from public.reports`)).length, 0);

  // Normal users hold no UPDATE/DELETE grant at all.
  await expectFailure(
    () => rows(`update public.reports set status = 'REVIEWED'`),
    'permission denied'
  );
  await expectFailure(() => rows(`delete from public.reports`), 'permission denied');

  // Staff (staff_admins registry) can read the full contents.
  await actAs(userStaff.id);
  const staffView = await rows(`select reporter_profile_id, reported_profile_id, reason, detail, status from public.reports`);
  assert.ok(staffView.length >= 5, 'staff must see the reports');
  assert.ok(staffView.every((r) => r.reporter_profile_id !== null && r.reason !== null));

  // Anonymous callers are denied outright.
  await actAs(null);
  await expectFailure(() => rows(`select 1 from public.reports`), 'permission denied');
});

test('69 · safety: a block hides the match and messages both ways, restores on unblock', async () => {
  await actAsService();
  const [smallerBC, largerBC] = [safeProfileB.id, safeProfileC.id].sort();
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smallerBC, largerBC]
  );
  await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'before the block') returning id`,
    [match.id, safeProfileB.id]
  );

  // Pre-block sanity: both participants can read the match and its messages.
  const [userOfB, userOfC] = safeProfileB.id === smallerBC ? [safeUserB, safeUserC] : [safeUserC, safeUserB];
  const [profileOfB, profileOfC] = safeProfileB.id === smallerBC ? [safeProfileB, safeProfileC] : [safeProfileC, safeProfileB];
  await actAs(userOfB.id);
  assert.equal((await rows(`select 1 from public.matches where id = $1`, [match.id])).length, 1);
  assert.equal((await rows(`select 1 from public.messages where match_id = $1`, [match.id])).length, 1);
  await actAs(userOfC.id);
  assert.equal((await rows(`select 1 from public.matches where id = $1`, [match.id])).length, 1);

  // B blocks C.
  await actAs(userOfB.id);
  await one(
    `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2) returning id`,
    [profileOfB.id, profileOfC.id]
  );

  // The match and its messages are instantly invisible to BOTH sides —
  // including the participant who did NOT block.
  await actAs(userOfB.id);
  assert.equal((await rows(`select 1 from public.matches where id = $1`, [match.id])).length, 0);
  assert.equal((await rows(`select 1 from public.messages where match_id = $1`, [match.id])).length, 0);
  await actAs(userOfC.id);
  assert.equal((await rows(`select 1 from public.matches where id = $1`, [match.id])).length, 0);
  assert.equal((await rows(`select 1 from public.messages where match_id = $1`, [match.id])).length, 0);

  // The rows are retained (silence, not deletion).
  await actAsService();
  assert.equal((await rows(`select 1 from public.matches where id = $1`, [match.id])).length, 1);
  assert.equal((await rows(`select 1 from public.messages where match_id = $1`, [match.id])).length, 1);

  // Likes cannot cross an active block (defense-in-depth).
  await actAs(userOfB.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'LIKE', $3)`,
        [profileOfB.id, profileOfC.id, oppId]
      ),
    'row-level security'
  );

  // The send RPC refuses a blocked pair with the same error the backend maps
  // to 404.
  await actAsService();
  await expectFailure(
    () =>
      rows(`select public.send_conversation_message($1, $2, 'still blocked')`, [
        match.id,
        profileOfB.id,
      ]),
    'not an active participant'
  );

  // Unblock: everything is restored automatically — nothing was deleted.
  await actAs(userOfB.id);
  assert.equal(
    await touched(
      `delete from public.blocks where blocker_profile_id = $1 and blocked_profile_id = $2 returning 1`,
      [profileOfB.id, profileOfC.id]
    ),
    1
  );
  await actAs(userOfB.id);
  assert.equal((await rows(`select 1 from public.matches where id = $1`, [match.id])).length, 1);
  assert.equal((await rows(`select 1 from public.messages where match_id = $1`, [match.id])).length, 1);
  await actAs(userOfC.id);
  assert.equal((await rows(`select 1 from public.messages where match_id = $1`, [match.id])).length, 1);

  // Actions can cross again once unblocked…
  await actAs(userOfB.id);
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [profileOfB.id, profileOfC.id, oppId]
  );
  // …and the send RPC works again.
  await actAsService();
  const sent = await one(`select public.send_conversation_message($1, $2, 'unblocked again')`, [
    match.id,
    profileOfB.id,
  ]);
  assert.ok(sent.send_conversation_message);
});

// ============================================================================
// Ephemeral conversations slice — 24h inactivity expiry
// ============================================================================

// Fixtures: fresh verified pair + a third user (unauthorized probe) + a
// staff member (report-status transitions). Indexes must stay unique across
// the file (insertVerifiedUserFixture derives storage paths from them).
let expUserA, expUserB, expUserC, expStaff;
let expProfileA, expProfileB, expProfileC;
let expMatchId; // the A<->B conversation under test

test('70 · expiry: schema invariants — column, backfill, partial index', async () => {
  await actAsService();
  ({ user: expUserA, profile: expProfileA } = await insertVerifiedUserFixture('expiry-a', 'E1'));
  ({ user: expUserB, profile: expProfileB } = await insertVerifiedUserFixture('expiry-b', 'E2'));
  ({ user: expUserC, profile: expProfileC } = await insertVerifiedUserFixture('expiry-c', 'E3'));
  expStaff = await one(`insert into auth.users (email) values ('expiry-staff@example.test') returning id`);
  await one(`insert into public.staff_admins (auth_user_id) values ($1) returning auth_user_id`, [expStaff.id]);

  const [smallerAB, largerAB] = [expProfileA.id, expProfileB.id].sort();
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id, last_message_at`,
    [smallerAB, largerAB]
  );
  expMatchId = match.id;
  // A fresh match has NULL last_message_at — never active, nothing expires.
  assert.equal(match.last_message_at, null);

  // The expiration index exists.
  const indexes = await rows(`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'matches'
  `);
  assert.ok(
    indexes.map((i) => i.indexname).includes('matches_last_message_at_idx'),
    'expected the last_message_at expiration index'
  );

  // Backfill convention: messages inserted directly (service role) set the
  // window only through the send RPC's update — a plain INSERT deliberately
  // leaves last_message_at unchanged, so verify the RPC resets it (test 73).
});

test('71 · expiry: messages readable only while last_message_at is within 24h (RLS)', async () => {
  await actAsService();
  await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'recent message') returning id`,
    [expMatchId, expProfileA.id]
  );

  // Sanity: A is user_a or user_b — resolve both sides for the reads below.
  const sides = await one(`select user_a_id, user_b_id from public.matches where id = $1`, [expMatchId]);
  const userOfA = sides.user_a_id === expProfileA.id ? expUserA : expUserB;

  // Active (last_message_at NULL here — never set): readable by participants.
  await actAs(userOfA.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    1
  );

  // Age the window past 24h → the message is invisible to its participant…
  await actAsService();
  await one(`update public.matches set last_message_at = now() - interval '25 hours' where id = $1 returning 1`, [expMatchId]);
  await actAs(userOfA.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    0
  );

  // …while the row survives (RLS hides; cleanup deletes later)…
  await actAsService();
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    1
  );

  // …and inside the window (23h) it is readable again.
  await actAsService();
  await one(`update public.matches set last_message_at = now() - interval '23 hours' where id = $1 returning 1`, [expMatchId]);
  await actAs(userOfA.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    1
  );
});

test('72 · expiry: unauthorized users still cannot access conversations', async () => {
  const sides = await one(`select user_a_id, user_b_id from public.matches where id = $1`, [expMatchId]);
  const userOfA = sides.user_a_id === expProfileA.id ? expUserA : expUserB;

  // Nonparticipant sees nothing whether the conversation is active or not.
  await actAs(expUserC.id);
  assert.equal((await rows(`select id from public.messages`)).length, 0);
  await actAsService();
  await one(`update public.matches set last_message_at = now() where id = $1 returning 1`, [expMatchId]);
  await actAs(expUserC.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    0
  );
  await actAs(userOfA.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    1
  );
});

test('73 · expiry: sending resets last_message_at and ticks only the recipient counter', async () => {
  await actAsService();
  const sides = await one(`select user_a_id, user_b_id from public.matches where id = $1`, [expMatchId]);
  const senderProfile = expProfileA;
  const recipientProfile = expProfileB;
  const senderIsA = sides.user_a_id === expProfileA.id;
  const senderCol = senderIsA ? 'user_a_unread_count' : 'user_b_unread_count';
  const recipientCol = senderIsA ? 'user_b_unread_count' : 'user_a_unread_count';

  await one(`update public.matches set last_message_at = now() - interval '25 hours' where id = $1 returning 1`, [expMatchId]);
  const before = await one(`select last_message_at from public.matches where id = $1`, [expMatchId]);

  const sent = await one(`select * from public.send_conversation_message($1, $2, 'window reset')`, [
    expMatchId,
    senderProfile.id,
  ]);
  assert.equal(sent.body, 'window reset');

  const after = await one(
    `select last_message_at, user_a_unread_count, user_b_unread_count
     from public.matches where id = $1`,
    [expMatchId]
  );
  assert.ok(after.last_message_at.getTime() > before.last_message_at.getTime(), 'window must reset');
  assert.ok(Math.abs(after.last_message_at.getTime() - sent.created_at.getTime()) < 1000);
  assert.equal(after[recipientCol], 1);
  assert.equal(after[senderCol], 0);
  assert.ok(recipientProfile.id); // sides resolved; no unused-var lint
});

test('74 · expiry: send-after-expiry deletes old messages first (fresh start)', async () => {
  await actAsService();
  // Seed an old message directly and age the conversation past 24h.
  const old = await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'ancient history') returning id`,
    [expMatchId, expProfileA.id]
  );
  await one(`update public.matches set last_message_at = now() - interval '30 hours' where id = $1 returning 1`, [expMatchId]);

  // The expired message is already invisible (RLS, test 71)…
  await actAs(expUserB.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    0
  );

  // …and the restart send deletes it from the database entirely.
  await actAsService();
  await one(`select public.send_conversation_message($1, $2, 'fresh start')`, [expMatchId, expProfileA.id]);
  assert.equal(
    (await rows(`select id from public.messages where id = $1`, [old.id])).length,
    0,
    'expired content must never become visible again'
  );
  const history = await rows(
    `select body from public.messages where match_id = $1 order by created_at`,
    [expMatchId]
  );
  // The restart wipes the whole expired conversation — only the new message
  // remains; old content can never reappear.
  assert.deepEqual(history.map((r) => r.body), ['fresh start']);
});

test('75 · expiry: cleanup deletes at 24h and keeps OPEN-report rows out of participant history', async () => {
  await actAsService();
  // Age just past the single 24h boundary — there is no extra retention.
  await one(`update public.matches set last_message_at = now() - interval '25 hours' where id = $1 returning 1`, [expMatchId]);
  await rows(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'reported content'), ($1, $2, 'ordinary expired')`,
    [expMatchId, expProfileB.id]
  );
  // An OPEN report pins one of the messages.
  const reported = await one(
    `select id from public.messages where body = 'reported content'`
  );
  await one(
    `insert into public.reports (reporter_profile_id, reported_profile_id, reason, content_type, content_id)
     values ($1, $2, 'harassment', 'message', $3) returning id`,
    [expProfileA.id, expProfileB.id, reported.id]
  );
  await one(`update public.matches set user_a_unread_count = 3, user_b_unread_count = 5 where id = $1 returning 1`, [expMatchId]);

  const cleaned = await one(`select public.expire_stale_conversations() as n`);
  assert.ok(cleaned.n >= 1, 'the expired conversation must be cleaned');

  // Ordinary expired messages are gone; the OPEN-reported message survives…
  const remaining = await rows(
    `select body, expired_at from public.messages where match_id = $1`,
    [expMatchId]
  );
  assert.deepEqual(remaining.map((r) => r.body), ['reported content']);
  assert.notEqual(remaining[0].expired_at, null, 'pinned survivor must be marked expired');
  // …the chat is over, so its unread counters are reset.
  const counters = await one(
    `select user_a_unread_count, user_b_unread_count from public.matches where id = $1`,
    [expMatchId]
  );
  assert.equal(counters.user_a_unread_count, 0);
  assert.equal(counters.user_b_unread_count, 0);

  // The reported message is still invisible to ordinary users (expired)…
  await actAs(expUserB.id);
  assert.equal(
    (await rows(`select id from public.messages where match_id = $1`, [expMatchId])).length,
    0
  );

  // …but staff reach it through the service role (reports are admin-only).
  await actAsService();
  assert.equal((await rows(`select id from public.messages where id = $1`, [reported.id])).length, 1);

  // A restart must not revive the retained report row in participant history.
  const restarted = await one(
    `select * from public.send_conversation_message($1, $2, 'restarted after cleanup')`,
    [expMatchId, expProfileA.id]
  );
  await actAs(expUserB.id);
  const afterRestart = await rows(
    `select body from public.messages where match_id = $1 order by created_at`,
    [expMatchId]
  );
  assert.deepEqual(afterRestart.map((r) => r.body), ['restarted after cleanup']);

  // A completed restart resets the window; cleanup must leave its message alone.
  await actAsService();
  await one(`select public.expire_stale_conversations()`);
  assert.equal(
    (await rows(`select id from public.messages where id = $1`, [restarted.id])).length,
    1,
    'cleanup must never delete a message from a completed restart'
  );

  // Age that round too, then close the report → cleanup removes everything.
  await one(`update public.matches set last_message_at = now() - interval '25 hours' where id = $1 returning 1`, [expMatchId]);
  await one(`update public.reports set status = 'DISMISSED' where content_id = $1 returning 1`, [reported.id]);
  const cleanedAgain = await one(`select public.expire_stale_conversations() as n`);
  assert.ok(cleanedAgain.n >= 1);
  assert.equal((await rows(`select id from public.messages where id = $1`, [reported.id])).length, 0);
  assert.equal((await rows(`select id from public.messages where id = $1`, [restarted.id])).length, 0);
  const countersAfter = await one(
    `select user_a_unread_count, user_b_unread_count from public.matches where id = $1`,
    [expMatchId]
  );
  assert.equal(countersAfter.user_a_unread_count, 0);
  assert.equal(countersAfter.user_b_unread_count, 0);
});

test('76 · expiry: cleanup leaves younger chats alone, then deletes them at 24h', async () => {
  await actAsService();
  const [smaller, larger] = [expProfileB.id, expProfileC.id].sort();
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smaller, larger]
  );
  const keep = await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'not yet expired') returning id`,
    [match.id, expProfileB.id]
  );
  await one(`update public.matches set last_message_at = now() - interval '23 hours' where id = $1 returning 1`, [match.id]);

  // 23h is still inside the single 24h window: cleanup must not touch it.
  await one(`select public.expire_stale_conversations()`);
  assert.equal((await rows(`select id from public.messages where id = $1`, [keep.id])).length, 1);

  // One hour later the same cleanup physically deletes it.
  await one(`update public.matches set last_message_at = now() - interval '25 hours' where id = $1 returning 1`, [match.id]);
  await one(`select public.expire_stale_conversations()`);
  assert.equal((await rows(`select id from public.messages where id = $1`, [keep.id])).length, 0);

  // The match survives and either side can start a fresh, empty-history chat.
  const restarted = await one(
    `select * from public.send_conversation_message($1, $2, 'revived')`,
    [match.id, expProfileB.id]
  );
  assert.ok(restarted.id);
  const sides = await one(`select user_a_id, user_b_id from public.matches where id = $1`, [match.id]);
  const userOfB = sides.user_a_id === expProfileB.id ? expUserB : expUserC;
  await actAs(userOfB.id);
  const visible = await rows(`select body from public.messages where match_id = $1 order by created_at`, [match.id]);
  assert.deepEqual(visible.map((r) => r.body), ['revived']);
});

test('77 · expiry: block and unmatch still take precedence and behave unchanged', async () => {
  await actAsService();
  const [smaller, larger] = [expProfileA.id, expProfileC.id].sort();
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smaller, larger]
  );
  await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'before block') returning id`,
    [match.id, expProfileA.id]
  );
  const sides = await one(`select user_a_id, user_b_id from public.matches where id = $1`, [match.id]);
  const userOfA = sides.user_a_id === expProfileA.id ? expUserA : expUserC;

  // Unmatched: invisible regardless of window; unmatch semantics untouched.
  await one(`update public.matches set unmatched_at = now() where id = $1 returning 1`, [match.id]);
  await actAs(userOfA.id);
  assert.equal((await rows(`select id from public.messages where match_id = $1`, [match.id])).length, 0);
  await actAsService();
  await expectFailure(
    () =>
      rows(`select public.send_conversation_message($1, $2, 'after unmatch')`, [match.id, expProfileA.id]),
    'not an active participant'
  );

  // Re-activate, then block: same silence in both directions.
  await one(`update public.matches set unmatched_at = null where id = $1 returning 1`, [match.id]);
  const sides2 = await one(`select user_a_id, user_b_id from public.matches where id = $1`, [match.id]);
  const [profileOfA, profileOfC] =
    sides2.user_a_id === expProfileA.id ? [expProfileA, expProfileC] : [expProfileC, expProfileA];
  const [userOfA2, userOfC2] =
    sides2.user_a_id === expProfileA.id ? [expUserA, expUserC] : [expUserC, expUserA];
  await one(
    `insert into public.blocks (blocker_profile_id, blocked_profile_id) values ($1, $2) returning id`,
    [profileOfA.id, profileOfC.id]
  );
  await actAs(userOfA2.id);
  assert.equal((await rows(`select id from public.messages where match_id = $1`, [match.id])).length, 0);
  await actAs(userOfC2.id);
  assert.equal((await rows(`select id from public.messages where match_id = $1`, [match.id])).length, 0);
  await actAsService();
  await one(`delete from public.blocks where blocker_profile_id = $1 returning 1`, [profileOfA.id]);
});

test('87 · scheduling: the 24h migration installs the recurring cleanup job', async () => {
  await actAsService();
  const job = await one(
    `select jobname, schedule, command, active
     from cron.job
     where jobname = 'unimatch-expire-stale-conversations'`
  );
  assert.equal(job.schedule, '*/5 * * * *');
  assert.equal(job.command, 'select public.expire_stale_conversations();');
  assert.equal(job.active, true);
});

test('88 · expiry: backfill hides legacy report-pinned survivors after a restart', async () => {
  await actAsService();
  const { user: bfUserA, profile: bfProfileA } = await insertVerifiedUserFixture('backfill-a', 'BF1');
  const { user: bfUserB, profile: bfProfileB } = await insertVerifiedUserFixture('backfill-b', 'BF2');
  const [smaller, larger] = [bfProfileA.id, bfProfileB.id].sort();
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smaller, larger]
  );

  // Old-policy survivor: a report-pinned row from a round that expired before
  // a later restart. It has no expired_at marker (the column did not exist).
  const oldPinned = await one(
    `insert into public.messages (match_id, sender_profile_id, body, created_at)
     values ($1, $2, 'old pinned evidence', now() - interval '72 hours') returning id`,
    [match.id, bfProfileA.id]
  );
  await one(
    `insert into public.reports
       (reporter_profile_id, reported_profile_id, reason, content_type, content_id)
     values ($1, $2, 'harassment', 'message', $3) returning id`,
    [bfProfileA.id, bfProfileB.id, oldPinned.id]
  );

  // The current, continuously active round (every gap < 24h). One of its
  // messages is also report-pinned and must NOT be marked expired by backfill.
  const currentPinned = await one(
    `insert into public.messages (match_id, sender_profile_id, body, created_at)
     values ($1, $2, 'current pinned', now() - interval '30 hours') returning id`,
    [match.id, bfProfileB.id]
  );
  await one(
    `insert into public.reports
       (reporter_profile_id, reported_profile_id, reason, content_type, content_id)
     values ($1, $2, 'spam', 'message', $3) returning id`,
    [bfProfileA.id, bfProfileB.id, currentPinned.id]
  );
  await rows(
    `insert into public.messages (match_id, sender_profile_id, body, created_at)
     values
       ($1, $2, 'current -40h', now() - interval '40 hours'),
       ($1, $2, 'current -20h', now() - interval '20 hours'),
       ($1, $2, 'current -10h', now() - interval '10 hours')`,
    [match.id, bfProfileA.id]
  );
  const latest = await one(
    `insert into public.messages (match_id, sender_profile_id, body)
     values ($1, $2, 'current latest') returning created_at`,
    [match.id, bfProfileA.id]
  );
  await one(
    `update public.matches set last_message_at = $2 where id = $1 returning 1`,
    [match.id, latest.created_at]
  );

  // Precondition: the legacy survivor is visible because the restarted round
  // reset the 24h window. This is the bug the backfill must close.
  await actAs(bfUserA.id);
  const before = await rows(
    `select body from public.messages where match_id = $1`,
    [match.id]
  );
  assert.ok(
    before.some((r) => r.body === 'old pinned evidence'),
    'precondition: a legacy pinned row is visible before the backfill'
  );

  // Re-running the new migration applies the same idempotent backfill a real
  // deployment would run once.
  await actAsService();
  await exec(expiry24hSql);

  const markedOld = await one(
    `select expired_at from public.messages where id = $1`,
    [oldPinned.id]
  );
  assert.notEqual(markedOld.expired_at, null, 'legacy survivor must be marked expired');
  const markedCurrent = await one(
    `select expired_at from public.messages where id = $1`,
    [currentPinned.id]
  );
  assert.equal(markedCurrent.expired_at, null, 'current-round messages stay visible');

  // Participants see only the current round; the evidence row is retained for
  // staff and remains reachable through the service role.
  await actAs(bfUserA.id);
  const after = await rows(
    `select body from public.messages where match_id = $1 order by created_at`,
    [match.id]
  );
  assert.ok(!after.some((r) => r.body === 'old pinned evidence'));
  assert.equal(after.length, 5);

  await actAsService();
  assert.equal(
    (await rows(`select 1 from public.messages where id = $1`, [oldPinned.id])).length,
    1,
    'moderation evidence must not be deleted'
  );

  // Idempotent: a second run preserves the original expiration marker.
  const firstMarker = markedOld.expired_at.getTime();
  await exec(expiry24hSql);
  const markedAgain = await one(
    `select expired_at from public.messages where id = $1`,
    [oldPinned.id]
  );
  assert.equal(markedAgain.expired_at.getTime(), firstMarker);
});

test('89 · scheduling: migration aborts and rolls back when pg_cron cannot be installed', async () => {
  const failDb = new PGlite();
  try {
    await failDb.exec(bootstrapSql);
    await applyMigrationsBeforeExpiry(failDb);

    await failDb.exec('begin');
    try {
      await assert.rejects(
        () => failDb.exec(expiry24hSql),
        /could not be scheduled|pg_cron is unavailable/
      );
    } finally {
      await failDb.exec('rollback');
    }

    const cols = await failDb.query(
      `select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'messages'
         and column_name = 'expired_at'`
    );
    assert.equal(cols.rows.length, 0, 'failed migration must not leave partial changes');
  } finally {
    await failDb.close();
  }
});

test('90 · scheduling: migration aborts and rolls back when the cleanup job cannot be scheduled', async () => {
  const failDb = new PGlite();
  try {
    await failDb.exec(bootstrapSql);
    await failDb.exec(fakeCronSql);
    await failDb.exec(`
      create or replace function cron.schedule(
        job_name text,
        schedule text,
        command text
      ) returns bigint
      language plpgsql
      as $fn$
      begin
        raise exception 'simulated pg_cron schedule failure';
      end;
      $fn$;
    `);
    await applyMigrationsBeforeExpiry(failDb);

    await failDb.exec('begin');
    try {
      await assert.rejects(
        () => failDb.exec(expiry24hSql),
        /could not be scheduled/
      );
    } finally {
      await failDb.exec('rollback');
    }

    const cols = await failDb.query(
      `select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'messages'
         and column_name = 'expired_at'`
    );
    assert.equal(cols.rows.length, 0, 'failed migration must not leave partial changes');
    const jobs = await failDb.query(`select 1 from cron.job`);
    assert.equal(jobs.rows.length, 0, 'no partial schedule may survive the failure');
  } finally {
    await failDb.close();
  }
});

// ============================================================================
// Phase 1 (pivot) — categories/activities, opportunities, applications,
// contextual matching, suspensions, report context
// ============================================================================

test('78 · categories/activities: readable by all, admin-writable only (RLS + grants)', async () => {
  // Seeded reference data is present (seed.sql applied after migrations).
  const cats = await rows(`select name from public.categories order by sort_order`);
  assert.ok(cats.some((c) => c.name === 'Sports'));
  assert.ok(cats.some((c) => c.name === 'Travel'));

  // anon can read the catalogs.
  await actAs(null);
  const anonCats = await rows(`select name from public.categories`);
  assert.ok(anonCats.length >= 6, 'seeded + fixture categories are readable');
  assert.ok(anonCats.some((c) => c.name === 'Sports'));
  assert.ok(anonCats.some((c) => c.name === 'Fixture Category'));
  assert.ok((await rows(`select 1 from public.activities`)).length >= 33);

  // authenticated can read too, but cannot modify the catalogs.
  await actAs(userA.id);
  assert.ok((await rows(`select 1 from public.categories`)).length >= 6);
  await expectFailure(
    () => rows(`insert into public.categories (name, slug) values ('Hacked', 'hacked')`),
    'permission denied'
  );
  await expectFailure(() => rows(`update public.categories set name = 'Hacked'`), 'permission denied');
  await expectFailure(() => rows(`delete from public.categories`), 'permission denied');
  await expectFailure(
    () =>
      rows(
        `insert into public.activities (category_id, name, slug) values ($1, 'Hacked', 'hacked')`,
        [catFixture.id]
      ),
    'permission denied'
  );

  // Case-insensitive uniqueness on category name/slug.
  await actAsService();
  await expectFailure(
    () => rows(`insert into public.categories (name, slug) values ('sports', 'another')`),
    'duplicate key'
  );
  await expectFailure(
    () => rows(`insert into public.categories (name, slug) values ('Another', 'SPORTS')`),
    'duplicate key'
  );
});

test('79 · opportunities: only PUBLISHED is public; users have no write path', async () => {
  await actAsService();
  const draft = await one(
    `insert into public.opportunities
       (title, category_id, activity_id, description, status)
     values ('Draft Event', $1, $2, 'fixture', 'DRAFT') returning id`,
    [catFixture.id, actFixture.id]
  );
  const paused = await one(
    `insert into public.opportunities
       (title, category_id, activity_id, description, status)
     values ('Paused Event', $1, $2, 'fixture', 'PAUSED') returning id`,
    [catFixture.id, actFixture.id]
  );

  // Normal users (and anon) see only PUBLISHED opportunities.
  await actAs(userA.id);
  const visible = await rows(`select title from public.opportunities`);
  assert.ok(visible.some((o) => o.title === 'Fixture Event'), 'published must be visible');
  assert.ok(visible.every((o) => o.title !== 'Draft Event' && o.title !== 'Paused Event'));

  // No user write path — opportunity management is service role / admin only.
  await expectFailure(
    () =>
      rows(
        `insert into public.opportunities (title, category_id, description, status)
         values ('Hacked', $1, 'x', 'PUBLISHED')`,
        [catFixture.id]
      ),
    'permission denied'
  );
  await expectFailure(
    () => rows(`update public.opportunities set status = 'CANCELLED'`),
    'permission denied'
  );
  await expectFailure(() => rows(`delete from public.opportunities`), 'permission denied');

  // Status CHECK and title rules hold.
  await actAsService();
  await expectFailure(
    () =>
      rows(
        `insert into public.opportunities
           (title, category_id, activity_id, description, status)
         values ('Bad Status', $1, $2, 'fixture', 'PUBLIC')`,
        [catFixture.id, actFixture.id]
      ),
    'opportunities_status_valid'
  );
  await expectFailure(
    () =>
      rows(
        `insert into public.opportunities (title, category_id, description, status) values ('', $1, 'x', 'DRAFT')`,
        [catFixture.id]
      ),
    'opportunities_title_valid'
  );
});

test('80 · applications: apply with own verified profile; duplicates blocked; withdraw is a status change', async () => {
  await actAsService();
  const { user: appUser, profile: appProfile } = await insertVerifiedUserFixture('applications-a', 'X1');
  const opp = await insertPublishedOpportunity('Application Event');

  // Owner applies — the existing profile is referenced, not duplicated.
  await actAs(appUser.id);
  const app = await one(
    `insert into public.applications (opportunity_id, profile_id) values ($1, $2) returning id, status`,
    [opp.id, appProfile.id]
  );
  assert.equal(app.status, 'APPLIED');

  // Duplicate application for the same user + opportunity is impossible.
  await expectFailure(
    () =>
      rows(`insert into public.applications (opportunity_id, profile_id) values ($1, $2)`, [
        opp.id,
        appProfile.id,
      ]),
    'applications_opportunity_profile_key'
  );

  // Owner can read their own applications.
  assert.equal((await rows(`select id from public.applications where profile_id = $1`, [appProfile.id])).length, 1);

  // Non-owner cannot read/insert.
  await actAs(userW.id);
  assert.equal((await rows(`select 1 from public.applications`)).length, 0);
  await expectFailure(
    () =>
      rows(`insert into public.applications (opportunity_id, profile_id) values ($1, $2)`, [
        opp.id,
        appProfile.id,
      ]),
    'row-level security'
  );

  // Owner can withdraw (status transition) and re-apply by updating back.
  await actAs(appUser.id);
  await one(`update public.applications set status = 'WITHDRAWN' where id = $1 returning 1`, [app.id]);
  const withdrawn = await one(`select status from public.applications where id = $1`, [app.id]);
  assert.equal(withdrawn.status, 'WITHDRAWN');
  await one(`update public.applications set status = 'APPLIED' where id = $1 returning 1`, [app.id]);

  // Unverified users cannot apply.
  await actAs(userW.id);
  await expectFailure(
    () => rows(`insert into public.applications (opportunity_id, profile_id) values ($1, $2)`, [opp.id, profileW.id]),
    'row-level security'
  );

  // Applying to a non-PUBLISHED opportunity is blocked by RLS.
  await actAsService();
  const draftOpp = await one(
    `insert into public.opportunities (title, category_id, description, status)
     values ('Draft For Apps', $1, 'fixture', 'DRAFT') returning id`,
    [catFixture.id]
  );
  await actAs(appUser.id);
  await expectFailure(
    () =>
      rows(`insert into public.applications (opportunity_id, profile_id) values ($1, $2)`, [
        draftOpp.id,
        appProfile.id,
      ]),
    'row-level security'
  );
});

test('81 · contextual matching: actions require a PUBLISHED opportunity and the same pair can match in different opportunities', async () => {
  await actAsService();
  const draftOpp = await one(
    `insert into public.opportunities (title, category_id, description, status)
     values ('Draft For Actions', $1, 'fixture', 'DRAFT') returning id`,
    [catFixture.id]
  );
  const { user: ctxUserA, profile: ctxProfileA } = await insertVerifiedUserFixture('ctx-a', 'CA');
  const { user: ctxUserB, profile: ctxProfileB } = await insertVerifiedUserFixture('ctx-b', 'CB');

  // Action on a DRAFT opportunity is refused by RLS (not published).
  await actAs(ctxUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
         values ($1, $2, 'LIKE', $3)`,
        [ctxProfileA.id, ctxProfileB.id, draftOpp.id]
      ),
    'row-level security'
  );

  // Mutual interest across TWO different published opportunities creates TWO
  // independent contextual matches.
  await actAsService();
  const oppOne = await insertPublishedOpportunity('Contextual One');
  const oppTwo = await insertPublishedOpportunity('Contextual Two');
  await actAs(ctxUserA.id);
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [ctxProfileA.id, ctxProfileB.id, oppOne.id]
  );
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [ctxProfileA.id, ctxProfileB.id, oppTwo.id]
  );
  await actAs(ctxUserB.id);
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [ctxProfileB.id, ctxProfileA.id, oppOne.id]
  );
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type, opportunity_id)
     values ($1, $2, 'LIKE', $3) returning id`,
    [ctxProfileB.id, ctxProfileA.id, oppTwo.id]
  );

  // Matches are created by the backend (no auto-trigger); the database must
  // allow the same pair to hold TWO independent contextual matches — one per
  // opportunity — and reject a duplicate within the same opportunity.
  await actAsService();
  const [smaller, larger] = [ctxProfileA.id, ctxProfileB.id].sort();
  const m1 = await one(
    `insert into public.matches (user_a_id, user_b_id, opportunity_id)
     values ($1, $2, $3) returning id, opportunity_id`,
    [smaller, larger, oppOne.id]
  );
  const m2 = await one(
    `insert into public.matches (user_a_id, user_b_id, opportunity_id)
     values ($1, $2, $3) returning id, opportunity_id`,
    [smaller, larger, oppTwo.id]
  );
  assert.notEqual(m1.opportunity_id, m2.opportunity_id);

  // Duplicate within the same opportunity is rejected by the partial unique
  // index (the concurrency arbiter for contextual matching).
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id, opportunity_id)
         values ($1, $2, $3)`,
        [smaller, larger, oppOne.id]
      ),
    'matches_pair_opportunity_unique'
  );

  // Exactly two contextual matches exist for the pair, one per opportunity.
  const matches = await rows(
    `select id, opportunity_id from public.matches
     where user_a_id = $1 and user_b_id = $2
     order by created_at`,
    [smaller, larger]
  );
  assert.equal(matches.length, 2);
  assert.deepEqual(new Set(matches.map((m) => m.opportunity_id)), new Set([oppOne.id, oppTwo.id]));
});

test('82 · suspensions: admin-only storage (no user policies)', async () => {
  await actAsService();
  const { user: susUser, profile: susProfile } = await insertVerifiedUserFixture('suspensions-a', 'SU1');

  // Ordinary users (verified or not) hold no grant at all.
  await actAs(userA.id);
  await expectFailure(() => rows(`select 1 from public.suspensions`), 'permission denied');
  await actAs(null);
  await expectFailure(() => rows(`select 1 from public.suspensions`), 'permission denied');

  // Service role (admin backend) can create a suspension.
  await actAsService();
  const suspension = await one(
    `insert into public.suspensions (profile_id, reason, suspended_until, created_by)
     values ($1, 'harassment', null, $2) returning id, profile_id`,
    [susProfile.id, userStaff.id]
  );
  assert.equal(suspension.profile_id, susProfile.id);

  // Even the suspended profile cannot read their own suspension row.
  await actAs(susUser.id);
  await expectFailure(() => rows(`select 1 from public.suspensions`), 'permission denied');

  // Indefinite vs timed expiry: suspended_until must be later than created_at.
  await actAsService();
  await expectFailure(
    () =>
      rows(
        `insert into public.suspensions (profile_id, reason, suspended_until, created_by)
         values ($1, 'bad', now() - interval '1 day', $2)`,
        [susProfile.id, userStaff.id]
      ),
    'suspensions_until_valid'
  );
});

test('83 · reports: content_type accepts opportunity (and rejects unknown kinds)', async () => {
  await actAsService();
  // An OPEN report may now reference an opportunity.
  const report = await one(
    `insert into public.reports
       (reporter_profile_id, reported_profile_id, reason, content_type, content_id)
     values ($1, $2, 'inappropriate_content', 'opportunity', $3) returning id, status`,
    [safeProfileA.id, safeProfileB.id, oppId]
  );
  assert.equal(report.status, 'OPEN');

  // Unknown content types are still rejected by the CHECK.
  await expectFailure(
    () =>
      rows(
        `insert into public.reports
           (reporter_profile_id, reported_profile_id, reason, content_type, content_id)
         values ($1, $2, 'other', 'group', $3)`,
        [safeProfileA.id, safeProfileB.id, oppId]
      ),
    'reports_content_type_valid'
  );
});

// ============================================================================
// Custom universities ("My university isn't listed")
// ============================================================================

const CUSTOM_UNI_USER = await (async () => {
  await actAsService();
  const u = await one(`insert into auth.users (email) values ('customuni@example.test') returning id`);
  await actAsService();
  return u;
})();

test('85 · a profile claims exactly one university: catalog row XOR custom name', async () => {
  // Catalog row only -> accepted.
  await actAs(CUSTOM_UNI_USER.id);
  const withCatalog = await one(
    `insert into public.profiles
       (auth_user_id, first_name, date_of_birth, university_id, course,
        academic_year, gender, seeking_gender, bio)
     values ($1, 'Custom', current_date - interval '21 years', $2,
             'BSc', 2, 'man', 'everyone', 'Hi')
     returning id, university_id, custom_university_name`,
    [CUSTOM_UNI_USER.id, university.id]
  );
  assert.ok(withCatalog.university_id, 'catalog university_id should be set');
  assert.equal(withCatalog.custom_university_name, null, 'catalog claim must leave the custom name NULL');

  // Custom name only -> accepted.
  await actAsService();
  const u2 = await one(`insert into auth.users (email) values ('customuni2@example.test') returning id`);
  await actAs(u2.id);
  const withCustom = await one(
    `insert into public.profiles
       (auth_user_id, first_name, date_of_birth, university_id, custom_university_name,
        course, academic_year, gender, seeking_gender, bio)
     values ($1, 'Custom', current_date - interval '21 years', null, 'Forest Research Institute',
             'BSc', 2, 'man', 'everyone', 'Hi')
     returning id, university_id, custom_university_name`,
    [u2.id]
  );
  assert.equal(withCustom.university_id, null, 'custom claim must leave university_id NULL');
  assert.equal(withCustom.custom_university_name, 'Forest Research Institute');

  // Both -> rejected by profiles_university_claimed.
  await actAsService();
  const u3 = await one(`insert into auth.users (email) values ('bothuni@example.test') returning id`);
  await actAs(u3.id);
  await expectFailure(
    () =>
      one(
        `insert into public.profiles
           (auth_user_id, first_name, date_of_birth, university_id, custom_university_name,
            course, academic_year, gender, seeking_gender, bio)
         values ($1, 'Both', current_date - interval '21 years', $2, 'Forest Research Institute',
                 'BSc', 2, 'man', 'everyone', 'Hi')
         returning id`,
        [u3.id, university.id]
      ),
    'profiles_university_claimed'
  );

  // Neither -> rejected by the same constraint.
  await actAsService();
  const u4 = await one(`insert into auth.users (email) values ('nouni@example.test') returning id`);
  await actAs(u4.id);
  await expectFailure(
    () =>
      one(
        `insert into public.profiles
           (auth_user_id, first_name, date_of_birth, university_id, custom_university_name,
            course, academic_year, gender, seeking_gender, bio)
         values ($1, 'Neither', current_date - interval '21 years', null, null,
                 'BSc', 2, 'man', 'everyone', 'Hi')
         returning id`,
        [u4.id]
      ),
    'profiles_university_claimed'
  );

  // A custom name never becomes a catalog row.
  await actAsService();
  const catalogNames = (await rows(`select name from public.universities`)).map((r) => r.name);
  assert.ok(!catalogNames.includes('Forest Research Institute'), 'custom university must not create a catalog record');
});

test('86 · custom university name must be pre-trimmed and length-checked', async () => {
  // Matches every other text column in this schema (first_name, hometown,
  // course): the CHECK requires the value to be ALREADY trimmed and the app
  // layer normalizes before writing. The DB rejects rather than silently
  // trimming, so a reviewer never sees an untrimmed name.
  await actAsService();
  const u = await one(`insert into auth.users (email) values ('trimuni@example.test') returning id`);
  await actAs(u.id);
  const trimmed = await one(
    `insert into public.profiles
       (auth_user_id, first_name, date_of_birth, university_id, custom_university_name,
        course, academic_year, gender, seeking_gender, bio)
     values ($1, 'Trim', current_date - interval '21 years', null, 'Panjab University',
             'BSc', 2, 'man', 'everyone', 'Hi')
     returning custom_university_name`,
    [u.id]
  );
  assert.equal(trimmed.custom_university_name, 'Panjab University');

  // Untrimmed input is rejected at the database boundary.
  await actAsService();
  const uPad = await one(`insert into auth.users (email) values ('paduni@example.test') returning id`);
  await actAs(uPad.id);
  await expectFailure(
    () =>
      one(
        `insert into public.profiles
           (auth_user_id, first_name, date_of_birth, university_id, custom_university_name,
            course, academic_year, gender, seeking_gender, bio)
         values ($1, 'Pad', current_date - interval '21 years', null, '  Panjab University  ',
                 'BSc', 2, 'man', 'everyone', 'Hi')
         returning id`,
        [uPad.id]
      ),
    'profiles_custom_university_name_valid'
  );

  await actAsService();
  const u2 = await one(`insert into auth.users (email) values ('longuni@example.test') returning id`);
  await actAs(u2.id);
  await expectFailure(
    () =>
      one(
        `insert into public.profiles
           (auth_user_id, first_name, date_of_birth, university_id, custom_university_name,
            course, academic_year, gender, seeking_gender, bio)
         values ($1, 'Long', current_date - interval '21 years', null, $2,
                 'BSc', 2, 'man', 'everyone', 'Hi')
         returning id`,
        [u2.id, 'x'.repeat(121)]
      ),
    'profiles_custom_university_name_valid'
  );
});