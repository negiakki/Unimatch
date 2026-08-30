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

// --- setup: Supabase Auth emulation + migration -----------------------------
await actAsService();
await exec(`
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
`);

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

test('01 · migrations create exactly the eleven expected tables on a clean database', async () => {
  const t = await rows(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  assert.deepEqual(
    t.map((r) => r.table_name).sort(),
    [
      'dating_actions',
      'interests',
      'matches',
      'messages',
      'profile_interests',
      'profile_photos',
      'profiles',
      'staff_admins',
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
  assert.equal(tables.length, 11);
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
  assert.equal(byTable['profiles'], 5); // 4 owner + profiles_select_verified
  assert.equal(byTable['profile_interests'], 5); // 4 owner + _select_verified
  assert.equal(byTable['profile_photos'], 5); // 4 owner + _select_verified
  assert.equal(byTable['staff_admins'], 1);
  assert.equal(byTable['verification_submissions'], 3);
  assert.equal(byTable['verification_reviews'], 1);
  assert.equal(byTable['dating_actions'], 2); // insert_own + select_own_outgoing
  assert.equal(byTable['matches'], 1); // select_participant
  assert.equal(byTable['messages'], 1); // select_participant (active matches only)
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
  assert.ok(uniCount >= 6, `expected at least 6 seeded universities, got ${uniCount}`);
  assert.ok(interestCount >= 18, `expected at least 18 seeded interests, got ${interestCount}`);

  // Second run must not duplicate anything.
  await exec(seedSql);
  assert.equal((await rows(`select count(*)::int as n from public.universities`))[0].n, uniCount);
  assert.equal((await rows(`select count(*)::int as n from public.interests`))[0].n, interestCount);
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
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
     values ($1, $2, 'LIKE') returning id, action_type, created_at`,
    [likeProfileA.id, likeProfileB.id]
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
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $1, 'LIKE')`,
        [likeProfileA.id]
      ),
    'dating_actions_no_self_action'
  );
});

test('45 · dating: exactly one action per actor/target pair (LIKE after PASS included)', async () => {
  await actAs(likeUserA.id);
  // Duplicate LIKE…
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $2, 'LIKE')`,
        [likeProfileA.id, likeProfileB.id]
      ),
    'dating_actions_actor_target_unique'
  );
  // …PASS on the same pair is the same unique slot — also rejected.
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $2, 'PASS')`,
        [likeProfileA.id, likeProfileB.id]
      ),
    'dating_actions_actor_target_unique'
  );
});

test('46 · dating: action_type is restricted to LIKE/PASS', async () => {
  await actAs(likeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $2, 'MAYBE')`,
        [likeProfileA.id, likeProfileB.id]
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
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $2, 'LIKE')`,
        [likeProfileA.id, likeProfileB.id]
      ),
    'row-level security'
  );
  // Nothing was created for likeProfileA.
  await actAsService();
  assert.equal(
    (await rows(`select 1 from public.dating_actions where actor_profile_id = $1`, [likeProfileA.id])).length,
    1 // only likeUserA's genuine action from test 43
  );
});

test('48 · dating: an unverified viewer cannot record actions', async () => {
  await actAs(userW.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $2, 'LIKE')`,
        [profileW.id, likeProfileA.id]
      ),
    'row-level security'
  );
});

test('49 · dating: an unverified target cannot be acted on', async () => {
  await actAs(likeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $2, 'LIKE')`,
        [likeProfileA.id, discProfilePending.id]
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
        `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
         values ($1, $2, 'LIKE')`,
        [likeProfileA.id, likeProfileB.id]
      ),
    'permission denied'
  );
});

test('51 · dating: incoming actions are never visible (no "who liked you")', async () => {
  // likeUserB records their own action on likeProfileA.
  await actAs(likeUserB.id);
  await one(
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
     values ($1, $2, 'LIKE') returning id`,
    [likeProfileB.id, likeProfileA.id]
  );

  // likeUserA cannot see the incoming LIKE targeting them…
  await actAs(likeUserA.id);
  assert.equal(
    (await rows(`select 1 from public.dating_actions where actor_profile_id = $1`, [likeProfileB.id])).length,
    0
  );
  // …only their own outgoing action.
  const mine = await rows(`select actor_profile_id from public.dating_actions`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].actor_profile_id, likeProfileA.id);
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

test('53 · matches: canonical pair ordering, uniqueness, no self-match, server-only writes', async () => {
  // Normal users hold no INSERT grant — matches are created only by the
  // backend's service-role atomic operation.
  await actAs(likeUserA.id);
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id) values ($1, $2)`,
        [likeProfileA.id, likeProfileB.id]
      ),
    'permission denied'
  );

  await actAsService();
  // Canonical ordering is enforced (user_a_id must be the smaller uuid).
  const [smaller, larger] = [likeProfileA.id, likeProfileB.id].sort();
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id) values ($1, $2)`,
        [larger, smaller]
      ),
    'matches_canonical_pair_order'
  );
  // A profile cannot match itself.
  await expectFailure(
    () => rows(`insert into public.matches (user_a_id, user_b_id) values ($1, $1)`, [likeProfileA.id]),
    'matches_canonical_pair_order'
  );
  // The canonical insert succeeds…
  const match = await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id, created_at`,
    [smaller, larger]
  );
  matchId = match.id;
  // …and the pair is unique — a second row for the same pair is impossible.
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id) values ($1, $2)`,
        [smaller, larger]
      ),
    'matches_pair_unique'
  );
  // unmatched_at cannot precede created_at.
  await expectFailure(
    () =>
      rows(
        `insert into public.matches (user_a_id, user_b_id, created_at, unmatched_at)
         values ($1, $2, now(), now() - interval '1 hour')`,
        [smaller, larger]
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
    `insert into public.dating_actions (actor_profile_id, target_profile_id, action_type)
     values ($1, $2, 'LIKE') returning id`,
    [profileCasc.id, likeProfileA.id]
  );
  await actAsService();
  const [smaller, larger] = [profileCasc.id, likeProfileA.id].sort();
  await one(
    `insert into public.matches (user_a_id, user_b_id) values ($1, $2) returning id`,
    [smaller, larger]
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
    names.includes('dating_actions_actor_target_unique'),
    'expected the unique (actor, target) index'
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
