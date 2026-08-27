# UniMatch — Database

> Status: **Core schema slice implemented** (`universities`, `profiles`,
> `interests`, `profile_interests`, `profile_photos` — migration
> `20260827120000_core_schema.sql`). Verification, dating, matching,
> messaging, safety, and notification tables are **not yet implemented**;
> the requirements for those remain design targets in this document.

## How the schema is managed

- PostgreSQL via Supabase; migrations live in `supabase/migrations/` and are
  applied with the Supabase CLI. Exactly one migration exists so far.
- Development seed data (fictional universities + interests only) lives in
  `supabase/seed.sql`; the Supabase CLI applies it after migrations on
  `supabase db reset`. It is idempotent (`on conflict do nothing`).
- The migration targets **Supabase PostgreSQL** — `profiles` references
  `auth.users`, which is managed by Supabase Auth and never duplicated.
- No credentials, keys, or connection strings appear in migrations or seed
  files.

## Implemented — core schema slice

### Tables

#### `universities` — supported university catalog (reference data)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `name` | text NOT NULL | 1–200 chars, no surrounding whitespace |
| `city` | text NOT NULL | 1–100 chars, no surrounding whitespace |
| `state` | text NULL | ≤ 100 chars when present (non-US universities) |
| `country` | text NOT NULL | 1–100 chars |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

#### `profiles` — the dating profile, 1:1 with a Supabase Auth user

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `auth_user_id` | uuid NOT NULL UNIQUE | FK → `auth.users(id)`; the only identity linkage |
| `first_name` | text NOT NULL | 1–50 chars |
| `date_of_birth` | date NOT NULL | source of age; 18+ enforced by CHECK (see below) |
| `university_id` | uuid NOT NULL | FK → `universities(id)` |
| `course` | text NOT NULL | 1–120 chars |
| `academic_year` | smallint NOT NULL | 1–8 (numeric to stay country-neutral) |
| `gender` | text NOT NULL | `woman` / `man` / `non_binary` / `other` |
| `seeking_gender` | text NOT NULL | `women` / `men` / `everyone` |
| `bio` | text NOT NULL | 1–500 chars |
| `relationship_intent` | text NULL | `casual` / `serious` / `friendship` / `not_sure` |
| `height_cm` | smallint NULL | 100–250 |
| `hometown` | text NULL | ≤ 100 chars |
| `profile_prompts` | jsonb NOT NULL | default `[]`; must be a JSON array (structure TBD) |
| `social_links` | jsonb NOT NULL | default `{}`; must be a JSON object (structure TBD) |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

**18+ enforcement.** `profiles_age_18_plus` CHECK:
`date_of_birth <= current_date - interval '18 years'`. PostgreSQL evaluates
CHECK constraints at INSERT/UPDATE time, so the cutoff is the **current
date, not a hardcoded date** (verified by tests: exactly-18-today passes,
17-years fails). See *Known PostgreSQL limitations* below.

#### `interests` — shared interest catalog (reference data)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `name` | text NOT NULL | 1–40 chars |
| `created_at` | timestamptz NOT NULL | |

#### `profile_interests` — many-to-many `profiles ↔ interests`

| Column | Type | Notes |
| --- | --- | --- |
| `profile_id` | uuid NOT NULL | FK → `profiles(id)` |
| `interest_id` | uuid NOT NULL | FK → `interests(id)` |
| `created_at` | timestamptz NOT NULL | |

Primary key `(profile_id, interest_id)` prevents duplicate associations.

#### `profile_photos` — ordered photo records (binaries in Supabase Storage)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `profile_id` | uuid NOT NULL | FK → `profiles(id)` |
| `storage_path` | text NOT NULL UNIQUE | Storage object key; **no binaries, no public URLs** |
| `position` | smallint NOT NULL | ≥ 1; lowest position = primary photo (product rule) |
| `is_primary` | boolean NOT NULL | default `false` |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

### Relationships & deletion behavior

```text
auth.users ──1:1── profiles ──N:1── universities
                       │
                       ├──1:N── profile_photos
                       └──N:M── interests (via profile_interests)
```

- `profiles.auth_user_id → auth.users(id)` **ON DELETE CASCADE** — deleting
  the auth identity removes the profile, which in turn cascades to the
  profile's photos and interest links (no orphans).
- `profiles.university_id → universities(id)` **ON DELETE RESTRICT** — a
  profile deletion never touches the university, and a university that is
  still referenced cannot be deleted.
- `profile_interests.profile_id` / `.interest_id` — both **ON DELETE
  CASCADE**; removing a profile or an interest removes its associations.
- `profile_photos.profile_id → profiles(id)` **ON DELETE CASCADE** — photo
  rows die with the profile (Storage object cleanup remains an application
  responsibility).

### Constraints & indexes

- Uniqueness: `profiles.auth_user_id` (1:1 with auth); case-insensitive
  university identity `(lower(name), lower(city), lower(coalesce(state,'')),
  lower(country))`; case-insensitive `interests.name`
  (`lower(name)`); `profile_interests` PK; `profile_photos.storage_path`;
  `profile_photos (profile_id, position)` (no duplicate ordering); partial
  unique index `profile_photos (profile_id) WHERE is_primary` (at most one
  primary photo per profile).
- Value checks: gender / seeking / relationship-intent sets, academic year
  1–8, height 100–250, position ≥ 1, text length + `btrim` checks on
  user-supplied strings, JSONB shape checks for prompts/social links.
- Secondary indexes: `profiles(university_id)`,
  `profile_interests(interest_id)`.

### Row Level Security

RLS is enabled on **all five tables** (deny-by-default). Policies:

| Table | Policies |
| --- | --- |
| `universities` | `SELECT` for `anon, authenticated` (`using (true)`). No mutation policies. |
| `interests` | `SELECT` for `anon, authenticated` (`using (true)`). No mutation policies. |
| `profiles` | Owner-only `SELECT`/`INSERT`/`UPDATE`/`DELETE` for `authenticated`: `auth_user_id = (select auth.uid())` (`WITH CHECK` on insert/update — a user cannot adopt or change to another user's identity). |
| `profile_interests` | Owner-only DML for `authenticated`: row belongs to the caller via `exists (select 1 from profiles p where p.id = profile_id and p.auth_user_id = (select auth.uid()))`. |
| `profile_photos` | Owner-only DML for `authenticated`: same `exists` predicate as `profile_interests`. |

Supporting behavior:

- Catalog mutation is doubly blocked for normal users: no RLS policies plus
  explicit `REVOKE INSERT/UPDATE/DELETE` on `universities` and `interests`
  from `anon`/`authenticated`. Only the service role (which bypasses RLS)
  manages catalogs.
- `anon` has no privileges on user-data tables; `authenticated` has plain
  DML grants on the three user-data tables only.
- `(select auth.uid())` is wrapped in a subselect so the planner evaluates
  it once per statement.
- **Discovery/visibility policies for other users' profiles are
  intentionally absent** — they arrive with the verification + discovery
  slices, together with the `VERIFIED` gate.

### Triggers

`public.set_updated_at()` (plpgsql, `search_path = ''`) maintains
`updated_at` on `universities`, `profiles`, and `profile_photos` before
update.

### Testing

`supabase/tests/` runs the migration against an embedded PostgreSQL
(`@electric-sql/pglite`, no Docker needed) with a minimal Supabase Auth
emulation (`auth.users`, `auth.uid()`, `anon`/`authenticated`/`service_role`
roles — test-only; production uses real Supabase Auth). It verifies tables,
1:1 profile↔auth linkage, duplicate prevention, FK/cascade behavior, photo
ownership, all cross-user RLS denial paths, catalog immutability, the
dynamic 18+ check, `updated_at` triggers, and seed idempotency.

```powershell
cd supabase/tests
npm install
npm test
```

Against a real local Supabase instance:

```powershell
supabase init        # once, if supabase/config.toml does not exist yet
supabase start
supabase db reset    # applies migrations + supabase/seed.sql
supabase db lint     # optional static checks
```

### Known PostgreSQL limitations & deferred decisions

- **Dynamic 18+ CHECK.** PostgreSQL allows non-immutable expressions like
  `current_date` in CHECK constraints but only evaluates them on write; the
  docs recommend immutable expressions. This is safe here because age is
  monotonic — a row valid on its write day can never violate the constraint
  later, so no re-check or pg_dump/restore drift is possible. The cutoff is
  genuinely dynamic (no hardcoded date).
- **Photo count and primary-photo invariant.** The PRD's 1–6 photo bounds
  and "primary = lowest position" are product rules enforced by the upcoming
  photo-management slice; the database guarantees at most one primary per
  profile and unique ordering, but cannot express the cross-row invariants
  without triggers (deliberately not added yet).
- **Value sets are preliminary.** `gender`, `seeking_gender`,
  `relationship_intent` choices are reasonable defaults awaiting product
  confirmation; changing them is a CHECK + data update.
- **`profile_prompts` / `social_links` shapes are TBD** — stored as JSONB
  with type-shape checks only; structure lands with the profile editor.
- The migration requires the Supabase `auth` schema; a vanilla PostgreSQL
  cannot apply it without an auth-schema emulation (as used by the tests).

## Requirements for future slices (NOT implemented yet)

The entities below remain **requirements only** — do not treat them as
existing tables.

### Verification

6. **Verifications** — one record per student-ID submission: document storage
   reference (never URL exposure), submission timestamp, current state
   (`PENDING` / `VERIFIED` / `REJECTED`), reviewer metadata upon decision,
   rejection reason when rejected. Resubmission after rejection creates new
   submissions while history remains auditable.
7. **Verification audit trail** — append-only record of every review
   decision: reviewer identity, decision, reason, timestamps. Must not be
   editable or deletable by normal flows. Needs a reviewer/admin notion from
   day one (v1: single trusted admin; extensible to more moderators).

### Dating core

8. **Likes** — actor → target action records used both for discovery
   exclusion and mutual-match detection. A pair cannot accumulate
   conflicting/duplicate active likes (exact constraint TBD).
9. **Passes** — actor → target "decline" records excluding targets from the
   feed. v1 treats passes as final (open question in PRD).
10. **Matches** — created when two eligible users mutually like each other;
    unordered participant pair with at-most-one-active-match dedupe;
    visibility limited to participants; tracks unmatched state.
11. **Conversations** — message containers for matches (likely 1:1 with an
    active match; final modeling TBD).
12. **Messages** — text messages within conversations: sender (participant),
    server-assigned timestamp/conversation ordering; participants-only
    readability enforced by policy; inaccessible after unmatch/block while
    retained per safety/retention rules. Typing indicators are **not**
    persisted (ephemeral via Realtime).

### Safety

13. **Blocks** — blocker → blocked pairs; drives discovery exclusion and
    messaging lockout in both directions of effect; reversible on unblock.
14. **Reports** — reporter, reported user, optional content reference,
    reason category, free-text detail, processing status for the admin
    workflow. Contents visible only to admins.

### Future-phase

15. **Notifications** — in-app notification records (e.g., match made, new
    message) with per-user read state; delivery channels are post-v1.

## Cross-cutting requirements (carried forward)

- All eligibility gates (18+, `VERIFIED`) resolvable by both FastAPI and RLS
  policies without N+1 fan-out — denormalization or helper functions likely
  needed when verification lands.
- Deletion propagation: removing an account cascades/anonymizes across
  profiles, photos, verifications, likes, passes, matches, conversations,
  messages consistent with retention rules (TBD). The core slice already
  cascades `auth.users → profiles → photos/interests`.
- Storage object references remain valid or clean up atomically with rows;
  Storage-side object deletion accompanies row deletion in the app layer.
- Verification states are exactly `PENDING`, `VERIFIED`, `REJECTED`; the
  manual admin decision is authoritative (automation never finalizes
  status).
- Student ID documents live in a private Storage bucket; the database stores
  references only, never the documents themselves.
- Blocked/report relationships must not leak identity to the targeted user.
