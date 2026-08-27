#!/usr/bin/env node
// ============================================================================
// UniMatch — database tests for the core schema slice.
//
// Applies the migration from supabase/migrations/ to an embedded PostgreSQL
// (@electric-sql/pglite) and exercises constraints + RLS as real SQL.
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

// --- locate the (single) migration -----------------------------------------
const migrationDir = join(here, '..', 'migrations');
const migrationFiles = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort();
assert.equal(
  migrationFiles.length,
  1,
  `expected exactly one migration file, found: ${migrationFiles.join(', ') || '(none)'}`
);
const migrationSql = readFileSync(join(migrationDir, migrationFiles[0]), 'utf8');
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
`);

// Apply the migration exactly as the Supabase CLI would.
await exec(migrationSql);

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

// ============================================================================
// Tests
// ============================================================================

test('01 · migration creates exactly the five core tables on a clean database', async () => {
  const t = await rows(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  assert.deepEqual(
    t.map((r) => r.table_name).sort(),
    ['interests', 'profile_interests', 'profile_photos', 'profiles', 'universities']
  );
});

test('02 · RLS is enabled on every core table and policies exist', async () => {
  const tables = await rows(`
    select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  `);
  assert.equal(tables.length, 5);
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
  assert.equal(byTable['profiles'], 4);
  assert.equal(byTable['profile_interests'], 4);
  assert.equal(byTable['profile_photos'], 4);
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
