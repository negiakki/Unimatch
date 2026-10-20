# UniMatch — Database

> Status: **implemented**. Every table below exists in a committed migration in
> `supabase/migrations/`; nothing here is a design target. The product is
> **opportunity-first** — people are discovered inside an opportunity they have
> joined — so the core entities are the category/activity catalog,
> `opportunities`, `applications`, and opportunity-scoped `dating_actions` /
> `matches`, with verification, photos, messaging, and safety layered on top.

Slices, in migration order:

| Slice | Migration | Adds |
| --- | --- | --- |
| Core schema | `20260827120000_core_schema.sql` | `universities`, `profiles`, `interests`, `profile_interests`, `profile_photos`, `set_updated_at()` |
| Verification | `20260827130000_verification.sql` | `staff_admins`, `verification_submissions`, `verification_reviews` + state-machine triggers |
| Verification Storage | `20260827140000_verification_storage.sql` | private `verification-documents` bucket |
| Profile-photo Storage | `20260827150000_profile_photos_storage.sql` | private `profile-photos` bucket |
| Discovery | `20260829120000_discovery.sql` | `is_profile_verified()`, `is_current_user_verified()` + cross-user SELECT policies |
| Likes/passes/matches | `20260830120000_likes_matches.sql` | `dating_actions`, `matches` |
| Service-role grants | `20260830130000_dating_service_role_grants.sql` | grants for the action/match write paths |
| Messaging | `20260830140000_messaging.sql` | `messages`, `send_conversation_message()`, unread counters |
| Safety | `20260831120000_safety_blocks_reports.sql` | `blocks`, `reports`, `pair_is_blocked()` |
| Profile preferences | `20260831140000_profile_preferences.sql` | `profiles.motivations`, `profiles.academic_year` 1–6, `custom_interests` |
| Custom-interests grants | `20260831150000_custom_interests_service_role_grants.sql` | service-role grants |
| `pair_is_blocked` grants | `20260928120000_pair_is_blocked_service_role_grant.sql` | service-role grant |
| Conversation expiry | `20260929003426_conversation_expiry.sql` | `matches.last_message_at`, 24h lapse, `expire_stale_conversations()` |
| Category & activity catalog | `20261006120000_categories_activities.sql` | `categories`, `activities` |
| Opportunities | `20261006130000_opportunities.sql` | `opportunities` |
| Applications | `20261006140000_applications.sql` | `applications` |
| Contextual matching | `20261006150000_contextual_matching.sql` | `dating_actions.opportunity_id`, `matches.opportunity_id` |
| Suspensions & report context | `20261006160000_suspensions_reports.sql` | `suspensions`, `reports.content_type += 'opportunity'` |
| Custom university | `20261007120000_custom_university.sql` | `profiles.custom_university_name`, exactly-one university claim |
| 24h deletion | `20261020120000_conversation_expiry_24h.sql` | deletes at the 24h boundary (no extra retention), `messages.expired_at`, report-safe restart, pg_cron schedule |

## How the schema is managed

- PostgreSQL via Supabase; migrations live in `supabase/migrations/` and are
  applied with the Supabase CLI. Twenty migrations exist (table above);
  later slices never modify earlier migrations.
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

#### `profiles` — the one universal UniMatch profile, 1:1 with a Supabase Auth user

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `auth_user_id` | uuid NOT NULL UNIQUE | FK → `auth.users(id)`; the only identity linkage |
| `first_name` | text NOT NULL | 1–50 chars |
| `date_of_birth` | date NOT NULL | source of age; 18+ enforced by CHECK (see below) |
| `university_id` | uuid NULL | FK → `universities(id)`; **nullable** since the custom-university slice |
| `custom_university_name` | text NULL | trimmed, 1–120 chars; free-text institution for students at an unlisted university |
| `course` | text NOT NULL | 1–120 chars |
| `academic_year` | smallint NOT NULL | 1–6 (numeric to stay country-neutral; Phase 9.3) |
| `gender` | text NOT NULL | `woman` / `man` / `non_binary` / `other` |
| `seeking_gender` | text NOT NULL | `women` / `men` / `everyone` — who you would like to meet |
| `bio` | text NOT NULL | 1–500 chars |
| `relationship_intent` | text NULL | `casual` / `serious` / `friendship` / `not_sure` — **legacy dating field**; retained for existing data, not surfaced by the product, removal is tracked |
| `height_cm` | smallint NULL | 100–250 |
| `hometown` | text NULL | ≤ 100 chars |
| `motivations` | text[] NOT NULL | default `[]`; "why I'm here" — values restricted by CHECK to `dating` / `making_friends` / `confidence_and_communication`; multiple selections allowed (Phase 9.3) |
| `profile_prompts` | jsonb NOT NULL | default `[]`; must be a JSON array (structure TBD) |
| `social_links` | jsonb NOT NULL | default `{}`; must be a JSON object (structure TBD) |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

**18+ enforcement.** `profiles_age_18_plus` CHECK:
`date_of_birth <= current_date - interval '18 years'`. PostgreSQL evaluates
CHECK constraints at INSERT/UPDATE time, so the cutoff is the **current
date, not a hardcoded date** (verified by tests: exactly-18-today passes,
17-years fails). See *Known PostgreSQL limitations* below.

**Exactly-one university claim.** `profiles_university_claimed` CHECK requires
exactly one of the two:

```text
(university_id IS NOT NULL AND custom_university_name IS NULL)     -- catalog row
OR (university_id IS NULL     AND custom_university_name IS NOT NULL)  -- typed name
```

Both-or-neither is rejected, so a profile can never be ambiguous for a
reviewer, and `university_id IS NULL` is a reliable signal that the typed name
must be read instead. A custom name **never** creates a `universities` row —
the catalog stays read-only reference data, so an unreviewed institution can
never leak into every other student's dropdown. Existing rows already satisfy
the constraint (catalog row set, custom name NULL), so no backfill was needed.

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

#### `custom_interests` — user-created interest names (Phase 9.3)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `profile_id` | uuid NOT NULL | FK → `profiles(id)` |
| `name` | text NOT NULL | 1–40 chars, no surrounding whitespace |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

Deliberately **separate from the shared `interests` catalog**: custom
interests are user-owned and never pollute the read-only reference data.
Uniqueness is **per profile and case-insensitive** — unique index on
`(profile_id, lower(name))`, so two users may both own "Indie Game Design"
while one user cannot own both "gaming" and "Gaming". A custom name that
case-insensitively duplicates a catalog entry is rejected by the API
(catalog entries should be selected instead) so the two sources never
overlap for future interest search/filtering. Catalog + custom interests
share one combined budget of 8 per profile, enforced by the API layer.

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
auth.users ──1:1── profiles ──N:1── universities (nullable — see below)
                       │
                       ├──1:N── profile_photos
                       ├──1:N── custom_interests
                       ├──1:N── verification_submissions
                       ├──1:N── applications
                       ├──1:N── blocks (as blocker / blocked)
                       ├──1:N── reports (as reporter / reported)
                       ├──1:N── suspensions
                       ├──1:N── dating_actions (as actor / target)
                       └──N:M── interests (via profile_interests)
```

- `profiles.auth_user_id → auth.users(id)` **ON DELETE CASCADE** — deleting
  the auth identity removes the profile, which in turn cascades to the
  profile's photos and interest links (no orphans).
- `profiles.university_id → universities(id)` **ON DELETE RESTRICT** — a
  profile deletion never touches the university, and a university that is
  still referenced cannot be deleted. The column is nullable so an unlisted
  institution can be typed instead; the XOR CHECK guarantees exactly one of
  the two university fields is set.
- `profile_interests.profile_id` / `.interest_id` — both **ON DELETE
  CASCADE**; removing a profile or an interest removes its associations.
- `custom_interests.profile_id → profiles(id)` **ON DELETE CASCADE** —
  custom interests die with the profile.
- `profile_photos.profile_id → profiles(id)` **ON DELETE CASCADE** — photo
  rows die with the profile (Storage object cleanup remains an application
  responsibility).

### Constraints & indexes

- Uniqueness: `profiles.auth_user_id` (1:1 with auth); case-insensitive
  university identity `(lower(name), lower(city), lower(coalesce(state,'')),
  lower(country))`; case-insensitive `interests.name`
  (`lower(name)`); per-profile case-insensitive
  `custom_interests (profile_id, lower(name))` (Phase 9.3);
  `profile_interests` PK; `profile_photos.storage_path`;
  `profile_photos (profile_id, position)` (no duplicate ordering); partial
  unique index `profile_photos (profile_id) WHERE is_primary` (at most one
  primary photo per profile).
- Value checks: gender / seeking / relationship-intent sets, academic year
  1–6, motivation value set (`profiles_motivations_valid`), height 100–250,
  position ≥ 1, text length + `btrim` checks on user-supplied strings,
  JSONB shape checks for prompts/social links, and the exactly-one university
  claim (`profiles_university_claimed`).
- Secondary indexes: `profiles(university_id)`,
  `profile_interests(interest_id)`, `custom_interests(profile_id)`.

### Row Level Security

RLS is enabled on **all five tables** (deny-by-default). Policies:

| Table | Policies |
| --- | --- |
| `universities` | `SELECT` for `anon, authenticated` (`using (true)`). No mutation policies. |
| `interests` | `SELECT` for `anon, authenticated` (`using (true)`). No mutation policies. |
| `profiles` | Owner-only `SELECT`/`INSERT`/`UPDATE`/`DELETE` for `authenticated`: `auth_user_id = (select auth.uid())` (`WITH CHECK` on insert/update — a user cannot adopt or change to another user's identity). Plus `profiles_select_verified`, a cross-user read added by the discovery slice. |
| `profile_interests` | Owner-only DML for `authenticated`: row belongs to the caller via `exists (select 1 from profiles p where p.id = profile_id and p.auth_user_id = (select auth.uid()))`. |
| `custom_interests` | Owner-only DML for `authenticated` (same `exists` predicate) plus a verified-viewer cross-read `SELECT` policy mirroring `profile_interests` (Phase 9.3). |
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
- **Discovery/visibility policies for other users' profiles** landed with the
  discovery slice (`20260829120000_discovery.sql`) — see *VERIFIED-gate
  discovery slice* below. They require **both** sides of the gate (a VERIFIED
  viewer and a VERIFIED target) and are the RLS half of the discovery feed's
  eligibility rules.

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
  and "primary = lowest position" are product rules enforced by the
  photo-management slice **in the backend service layer** (max count on
  upload; min count of 1 required before a verification submission is
  accepted, `photo_required`; `is_primary` re-derived from `position` on every
  mutation). The
  database guarantees at most one primary per profile and unique ordering
  (`UNIQUE (profile_id, position)`, partial unique index on `is_primary`);
  the cross-row invariants are deliberately not database triggers.
- **Value sets are preliminary.** `gender`, `seeking_gender`,
  `relationship_intent` choices are reasonable defaults awaiting product
  confirmation; changing them is a CHECK + data update.
- **`profile_prompts` / `social_links` shapes are TBD** — stored as JSONB
  with type-shape checks only; structure lands with the profile editor.
- The migration requires the Supabase `auth` schema; a vanilla PostgreSQL
  cannot apply it without an auth-schema emulation (as used by the tests).

## Implemented — student-ID verification slice

### Tables

#### `staff_admins` — registered reviewers (minimal reviewer/admin registry)

| Column | Type | Notes |
| --- | --- | --- |
| `auth_user_id` | uuid PK | FK → `auth.users(id)` ON DELETE CASCADE; a staff member is a real Supabase Auth identity |
| `created_at` | timestamptz NOT NULL | |

v1 has a single trusted admin; additional moderators are added by inserting
rows (no schema change needed). Both verification tables carry `RESTRICT`
foreign keys into this table, so an **invalid reviewer** (any auth user not
registered as staff) is impossible at the FK level, and a staff member with
recorded decisions cannot be hard-deleted (audit integrity — disable the
account instead).

#### `verification_submissions` — one row per student-ID submission

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE; exactly one owning profile |
| `status` | text NOT NULL | default `PENDING`; CHECK: exactly `PENDING` / `VERIFIED` / `REJECTED` |
| `storage_path` | text NOT NULL UNIQUE | private Supabase Storage object reference — **no binaries, no URLs**; immutable after submission |
| `submitted_at` | timestamptz NOT NULL | **server-assigned** (trigger, `clock_timestamp()`) — client cannot choose submission order |
| `reviewed_at` | timestamptz NULL | **server-assigned** at decision time; NULL while pending |
| `reviewer_id` | uuid NULL | FK → `staff_admins(auth_user_id)` ON DELETE RESTRICT; NULL until a decision |
| `rejection_reason` | text NULL | trimmed, 1–500 chars; present **iff** status is `REJECTED` |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

#### `verification_reviews` — append-only audit trail of review decisions

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `submission_id` | uuid NOT NULL | FK → `verification_submissions(id)` ON DELETE CASCADE |
| `reviewer_id` | uuid NOT NULL | FK → `staff_admins(auth_user_id)` ON DELETE RESTRICT |
| `decision` | text NOT NULL | CHECK: `VERIFIED` / `REJECTED` only |
| `rejection_reason` | text NULL | same "present iff REJECTED" rule as submissions |
| `created_at` | timestamptz NOT NULL | server-assigned at decision time |

Rows are written **only** by the decision trigger on
`verification_submissions` — an audit record for every decision is
structurally guaranteed and cannot be skipped. UPDATE and TRUNCATE on this
table raise an exception even for the service role (append-only); DELETE is
intentionally not blocked so account deletion can cascade audit records away.
Normal users hold no write grants and no RLS policy at all.

### Relationships & deletion behavior

```text
auth.users ──1:1── profiles ──1:N── verification_submissions ──1:N── verification_reviews
    │                                    (document reference only)              │
    └──────────1:N── staff_admins ◀────── reviewer_id (RESTRICT, both tables) ◀──┘
```

- `verification_submissions.profile_id → profiles(id)` **ON DELETE CASCADE**
  — submissions (and their audit records) die with the profile/account;
  Storage object cleanup remains an application responsibility.
- `verification_reviews.submission_id → verification_submissions(id)`
  **ON DELETE CASCADE** — audit records follow their submission. Minimized
  audit retention after account deletion remains a product TBD (see
  SECURITY.md).
- `*.reviewer_id → staff_admins(auth_user_id)` **ON DELETE RESTRICT** — a
  reviewer with recorded decisions can never be silently erased.

### Verification state machine

States are exactly `PENDING`, `VERIFIED`, `REJECTED` (plus the implicit,
never-stored "no submission yet"). Transitions, all trigger-enforced:

```text
(no submissions) ──submit──▶ PENDING          (owner INSERT; always born PENDING)
PENDING ──staff decision──▶ VERIFIED          (audit row auto-written)
PENDING ──staff decision──▶ REJECTED          (reason required; audit row auto-written)
REJECTED ──resubmit──▶ PENDING                (a NEW submission row; history kept)
VERIFIED ──▶ (terminal; further submissions rejected)
```

- Decided rows are **immutable**: no `VERIFIED/REJECTED → anything`
  transition exists; resubmission is a new row, keeping every historical
  submission auditable.
- At most one **active PENDING** submission per profile (partial unique
  index `verification_submissions_one_pending_per_profile_idx` — the hard
  guarantee under concurrency; the insert trigger additionally rejects
  duplicates with a friendly error).
- A profile that is already `VERIFIED` cannot submit again.
- The **current verification state is derived, not denormalized**: it is the
  status of the most recent submission (or NULL if none). There is
  deliberately no `verification_status` column on `profiles` — derivation is
  a single indexed lookup (`(profile_id, submitted_at desc)`) and can never
  drift from, or be manipulated against, the authoritative submission
  records.

### Status disclosure (deliberate omission)

There is intentionally **no** user-callable
`current_verification_status(profile_id)` helper: a SECURITY DEFINER
function executable by `authenticated` would let any user query the
verification state of **arbitrary** profiles (PENDING/REJECTED/VERIFIED
included). Status is obtainable only through the RLS policies above:

- owners read their own state via the owner-only SELECT policy on
  `verification_submissions` (latest submission = current state);
- staff read the review queue directly via the staff SELECT policy;
- cross-user surfaces use the boolean-only helpers
  `is_profile_verified()` / `is_current_user_verified()` (see *VERIFIED-gate
  discovery slice*), which reveal no more than the PRD's "verified" indicator —
  never arbitrary-profile statuses.

### Triggers (state machine enforcement)

All on `verification_submissions` unless noted; `SECURITY DEFINER` with
locked `search_path` so invariants hold regardless of calling role:

- **prepare_insert** (BEFORE INSERT) — mirrors the INSERT policy first
  (claim-bearing callers may only target their own profile; the denial is
  indistinguishable from an RLS violation so error timing cannot probe other
  profiles), requires status `PENDING`, force-assigns `submitted_at` and
  NULLs all review fields, rejects submissions for already-`VERIFIED`
  profiles and duplicate `PENDING` submissions.
- **guard_update** (BEFORE UPDATE) — `id`, `profile_id`, `storage_path`,
  `submitted_at`, `created_at` are immutable; without a status change the
  review fields may not move; with a status change only
  `PENDING → VERIFIED|REJECTED` is legal, a reviewer is required,
  `reviewed_at` is force-assigned server time, `REJECTED` requires a valid
  trimmed reason and `VERIFIED` forces the reason to NULL.
- **record_decision** (AFTER UPDATE) — on a legal decision, inserts the
  `verification_reviews` audit row automatically.
- **set_updated_at** — reuses the core trigger.
- **append-only guard** (on `verification_reviews`) — raises on UPDATE and
  TRUNCATE, even for the service role.

### Row Level Security (verification slice)

RLS is enabled on all three tables (deny-by-default). Policies:

| Table | Policies |
| --- | --- |
| `staff_admins` | `SELECT` own membership row only for `authenticated` (`auth_user_id = auth.uid()`); non-staff see nothing. |
| `verification_submissions` | Owner-only `SELECT`/`INSERT` (`profile_id` resolves to `auth.uid()` via `profiles`); staff `SELECT` (review queue). **No `UPDATE`/`DELETE` policies.** |
| `verification_reviews` | Staff-only `SELECT`. **No other policies.** |

Supporting behavior:

- Normal users additionally hold **no UPDATE/DELETE grant** on
  `verification_submissions` and **no write grants at all** on
  `verification_reviews`/`staff_admins` — self-verification, reviewer
  tampering, and audit faking fail with `permission denied` before RLS is
  even reached. `anon` has no grants on any verification table.
- SELECT grants on `staff_admins`/`verification_reviews` exist only so RLS
  policy expressions can evaluate staff membership; RLS still hides all rows
  from non-staff.
- Decisions are performed by the service role (FastAPI checks reviewer
  authorization against `staff_admins` before any privileged call); the
  database structurally enforces *what* a decision must look like, while the
  backend enforces *who* may make one.

### Testing (verification slice)

The shared harness (`supabase/tests/`, embedded PostgreSQL + Supabase Auth
emulation) now applies **all** migrations in filename order and covers, in
addition to the core suite: own-profile submission, cross-profile denial,
own-read / cross-read denial, self-`VERIFIED`/reviewer-tamper denial, audit
immutability, invalid states, duplicate-PENDING prevention, resubmission
history, decision mechanics (reviewer + reason required, server timestamps,
auto-audit), staff vs non-staff access, self-only status disclosure (no
arbitrary-profile status and no user-callable status helper), FK
cascade/restrict behavior, and anonymous denial.

## Implemented — profile-photo Storage slice

### Bucket: `profile-photos` (private)

| Setting | Value |
| --- | --- |
| `public` | **false** — never publicly readable |
| `file_size_limit` | 10 MB (10485760 bytes) |
| `allowed_mime_types` | `image/jpeg`, `image/png`, `image/webp` (photo-only; no PDF) |

Student ID documents and profile photos deliberately live in **separate
private buckets** (`verification-documents` vs `profile-photos`) with
different MIME policies.

### Object path convention

`<auth.uid()>/<random-unique-file-id>.<extension>` — the first path
component is the authenticated user's UUID and is the only ownership signal
(enforced by every policy). No names, profile IDs, or other personal data
appear in object paths.

### Storage RLS

Deny-by-default (anon holds no policy). For `authenticated`:

| Policy | Effect |
| --- | --- |
| `profile_photos_storage_select_own` | Read objects in the caller's own `<auth.uid()>/` directory of `profile-photos` only. |
| `profile_photos_storage_insert_own` | Upload into the caller's own directory only. |
| *(no update/delete policies)* | Normal users can never modify or remove photo objects; deletion is a backend workflow that keeps the row and object in step. |

Object delivery uses **short-lived signed URLs** generated server-side by
the backend's service-role client (default TTL 3600 s,
`PROFILE_PHOTOS_SIGNED_URL_TTL_SECONDS`). Storage paths are server-side
references only and are never returned to any client.

### Application-level photo rules (backend service layer)

- Maximum **6 photos** per profile (`photo_limit_reached` on upload).
- Uploads **append** to the end of the order; the first photo of an empty
  profile becomes the primary photo.
- Delete renumbers the remaining photos to 1..N (relative order preserved);
  the photo at position 1 is the primary photo.
- Reorder accepts a **full permutation** of the profile's photo ids; the
  photo placed first becomes primary.
- `is_primary` is re-derived from `position` on every mutation; the partial
  unique index guarantees at most one primary at the database level.
- Reordering and compaction run as individually-atomic PostgREST upserts
  (two-phase for reorder: offset then final positions), so a failure mid-way
  never violates the unique constraints and leaves a retryable, correctly
  ordered state.

### Testing (photo storage slice)

The shared harness (`supabase/tests/`) emulates the Storage objects the
migrations reference (`storage.buckets`, `storage.objects`,
`storage.foldername`, test-only) and covers: bucket configuration (private,
10 MB, photo-only MIME set), owner-scoped upload paths, cross-user and
cross-bucket denial, anon denial (reads return nothing; writes are rejected),
the absence of update/delete paths for normal users, and the one-row-per-
object `storage_path` uniqueness.

## Implemented — likes/passes/matches slice

### Tables

#### `dating_actions` — one immutable LIKE/PASS per (actor, target, opportunity)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `actor_profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `target_profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `action_type` | text NOT NULL | CHECK: exactly `LIKE` / `PASS` |
| `opportunity_id` | uuid NULL | FK → `opportunities(id)` ON DELETE CASCADE; added by the contextual-matching slice — NULL only for legacy rows |
| `created_at` | timestamptz NOT NULL | default `now()` |

- ONE table for both actions. The original `UNIQUE (actor_profile_id,
  target_profile_id)` was **dropped** by the contextual-matching slice and
  replaced by a partial unique index on
  `(actor_profile_id, target_profile_id, opportunity_id) WHERE opportunity_id
  IS NOT NULL` — so the same pair can act once per opportunity, but never
  twice in one. Including a LIKE after a PASS (or the reverse) in the same
  opportunity is impossible at the database level. Actions are viewer-scoped:
  acting on someone never affects the reverse direction.
- `CHECK (actor_profile_id <> target_profile_id)` rejects self-actions.
- No `updated_at`: actions are immutable for normal users in v1 (no
  UPDATE/DELETE grants or policies; only the service role can maintain them).
- Index: `dating_actions_target_profile_id_idx` (supports incoming-direction
  lookups, e.g. future surfaces over actions); the unique index doubles
  as the actor-direction index used by feed exclusion.

#### `matches` — explicit mutual-interest records, canonically ordered and opportunity-scoped

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `user_a_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE; the SMALLER of the two profile ids |
| `user_b_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE; the LARGER of the two profile ids |
| `opportunity_id` | uuid NULL | FK → `opportunities(id)` ON DELETE CASCADE; added by the contextual-matching slice — NULL only for legacy matches |
| `created_at` | timestamptz NOT NULL | default `now()` |
| `unmatched_at` | timestamptz NULL | set by the backend on unmatch; NULL while active |

- Canonical pair ordering: `CHECK (user_a_id < user_b_id)` (no self-match
  falls out of the same check). The original `UNIQUE (user_a_id, user_b_id)`
  was **dropped** by the contextual-matching slice and replaced by a partial
  unique index on
  `(user_a_id, user_b_id, opportunity_id) WHERE opportunity_id IS NOT NULL` —
  one match per pair per opportunity, and that index is the concurrency
  arbiter for mutual-interest dedupe. The same two profiles can hold
  independent matches through different opportunities.
- `CHECK (unmatched_at IS NULL OR unmatched_at >= created_at)`.
- Unmatching is a **soft transition**: the row is retained so an unmatched
  pair cannot rematch through normal discovery; the matches list shows only
  active rows.
- Indexes: `matches_user_a_id_idx`, `matches_user_b_id_idx` (participant
  lookup on both pair sides).

### Row Level Security (likes/passes/matches slice)

RLS is enabled on both tables (deny-by-default). Policies:

| Table | Policies |
| --- | --- |
| `dating_actions` | `INSERT` for `authenticated` only when `actor_profile_id` resolves to `auth.uid()` via `profiles`, the caller is VERIFIED (`is_current_user_verified()`), the target is a VERIFIED profile (`is_profile_verified(target_profile_id)`), the pair is not blocked (`pair_is_blocked(...)`), and `opportunity_id` is set and names a PUBLISHED opportunity. `SELECT` only the caller's own OUTGOING actions. **No UPDATE/DELETE policies.** |
| `matches` | `SELECT` when the caller is one of the two participants (resolved via `profiles.auth_user_id`). **No INSERT/UPDATE/DELETE policies.** |

Supporting behavior:

- A client cannot spoof `actor_profile_id` — the INSERT policy resolves the
  actor from `auth.uid()`, never from the payload.
- Incoming likes/passes are never visible to normal users ("who liked you"
  does not exist): the SELECT policy filters on the actor side only.
- Normal users hold **no UPDATE/DELETE grant** on `dating_actions` and **no
  write grants at all** on `matches`; `anon` has no grants on either table.
- Match creation and unmatch run exclusively through the backend's
  service-role client (which bypasses RLS): match rows are inserted in
  canonical order with a conflict-ignore upsert against the partial unique
  index so concurrent mutual interests in one opportunity converge on exactly
  one row; unmatch is a service-role UPDATE of `unmatched_at`.
- Verification-state disclosure is unchanged: the policies reuse the existing
  `is_profile_verified` / `is_current_user_verified` boolean helpers, which
  reveal nothing beyond the verified/unverified bit.

### Testing (likes/passes/matches slice)

The shared harness (`supabase/tests/`) covers, for this slice: the
self-action CHECK, the one-action-per-pair unique constraint (LIKE after PASS
included), the `action_type` CHECK, verified-viewer insert rules (spoofed
actor, unverified viewer, unverified target, anonymous denial), incoming-action
invisibility, missing UPDATE/DELETE grants, canonical pair ordering, pair
uniqueness, the no-self-match rule, `unmatched_at`/`created_at` consistency,
server-only match writes, participant-only match visibility (nonparticipants
and anon see nothing), FK cascade behavior for actions and matches, and the
presence of both action-direction indexes.

## Implemented — messaging slice

A conversation IS an active match: there is deliberately **no separate
conversations table**. The match id doubles as the conversation id, and every
read path requires the underlying match to still be ACTIVE
(`unmatched_at IS NULL`), so an unmatch makes the conversation inaccessible
immediately (rows retained). A conversation is also **temporary**: it lapses
after 24 hours without a new message (see *Ephemeral conversations* below).
Realtime is deferred; clients poll (~5s).

### Tables

#### `messages` — immutable participant text messages

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `match_id` | uuid NOT NULL | FK → `matches(id)` ON DELETE CASCADE |
| `sender_profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `body` | text NOT NULL | CHECK: `body = btrim(body) AND char_length(body) BETWEEN 1 AND 2000` |
| `created_at` | timestamptz NOT NULL | default `now()`; server-assigned |
| `expired_at` | timestamptz NULL | set when a report-pinned message survives its conversation's expiry; excluded from participant reads forever |

- Messages are immutable in v1: no UPDATE/DELETE grants or policies; there is
  no edit/delete path anywhere (backend included).
- The backend trims the body and rejects empty-after-trim bodies; the CHECK
  re-enforces the same rule at the database as defense-in-depth.
- Index: `messages_match_id_created_at_idx (match_id, created_at, id)` — one
  composite index serves the newest-page poll and the (created_at, id) keyset
  pagination in both directions.

#### `matches` — three conversation columns

| Column | Type | Notes |
| --- | --- | --- |
| `user_a_unread_count` | smallint NOT NULL DEFAULT 0 | messages user_a has not read |
| `user_b_unread_count` | smallint NOT NULL DEFAULT 0 | messages user_b has not read |
| `last_message_at` | timestamptz NULL | NULL = no message exchanged yet (nothing has expired); set to the newest message's `created_at` on every send |

- Simple per-participant counters (deliberately NOT per-message read
  receipts). `CHECK (user_a_unread_count >= 0 AND user_b_unread_count >= 0)`.
  Existing match rows default to 0 — no backfill needed.
- The counters live on the match row itself, so the conversations list needs
  no per-conversation message scan.
- `last_message_at` was backfilled from the latest message per match; matches
  with no messages stay NULL.

### Ephemeral conversations — 24h inactivity expiry

Messaging is for arranging something, not for replacing it. A conversation
expires **24 hours after its last message** — never after match creation.
`last_message_at IS NULL` means nothing has been exchanged, so there is nothing
to expire.

Enforcement is layered, and the database stays authoritative even if cleanup
runs late:

1. **RLS** — messages are readable only while the conversation is active
   (`last_message_at IS NULL OR last_message_at >= now() - interval '24
   hours'`) and `expired_at IS NULL`. Expired messages are invisible to
   participants immediately, with identical non-existence behavior to an
   unauthorized conversation.
2. **The send RPC** — when the conversation has already lapsed, its old
   messages are deleted **first** (unless held by an `OPEN` report), stale
   unread counters are zeroed, then the new message is inserted, the window
   resets to it, and the recipient's counter ticks — all in one transaction
   while holding the match row lock. Expired content can therefore **never
   reappear**: there is no soft-delete and no resurrect path. Report-pinned
   survivors are marked `expired_at`, so a restart cannot make them visible.
   The migration also backfills rows retained under the old 48h policy (any
   round before the latest >24h gap) so they stay out of participant history
   while remaining available to staff.
3. **Cleanup** — `public.expire_stale_conversations()` (service role only)
   physically deletes ordinary messages **at the same 24h boundary** — there
   is no extra retention window — and zeroes both counters. It locks
   each expired match with `FOR UPDATE SKIP LOCKED`, so it can never race a
   send/restart. Messages referenced by an `OPEN` report are never deleted;
   they are marked `expired_at` instead, remaining available only to staff
   through the service role. Scheduled every five minutes via `pg_cron`
   (`unimatch-expire-stale-conversations`).

#### `pg_cron` scheduling and failure modes

The migration attempts `create extension pg_cron with schema pg_catalog` when
the extension is absent, then schedules (or reschedules) the cleanup job.
Scheduling is **fail-closed**:

- **Extension cannot be created** (role lacks permission / extension not
  available): the migration aborts and rolls back. It is not recorded as
  applied, so the 24h deletion policy cannot go live without background
  cleanup.
- **Extension exists but grants/unschedule/schedule fail** (for example the
  job was created by a different role): the exception is not swallowed, so the
  migration aborts and is not recorded as applied. No partial schedule is
  left behind.
- **Extension exists but is not preloaded** (no scheduler process): the job
  row is created but never runs. This is only observable in the hosted
  project and must be checked after applying.

Hosted Supabase does not always let the migration role enable `pg_cron`; if it
cannot, enable it once in the Dashboard (Database → Extensions) or with
`create extension pg_cron with schema pg_catalog;`, then rerun/repair the
migration. Verify the job with:

```sql
select jobid, jobname, schedule, command, active
from cron.job
where jobname = 'unimatch-expire-stale-conversations';

select status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (
  select jobid from cron.job
  where jobname = 'unimatch-expire-stale-conversations'
)
order by start_time desc
limit 5;
```

`active = true`, a `*/5 * * * *` schedule, and recent successful run details
are the proof that cleanup is actually scheduled and running.

Expiry never unmatches or hides the match — only the messages lapse. Blocked
and unmatched conversations keep their existing inaccessibility semantics.
Index: partial `matches_last_message_at_idx (last_message_at) WHERE
last_message_at IS NOT NULL`.

### Functions

#### `send_conversation_message(p_match_id, p_sender_profile_id, p_body)`

One atomic backend operation: verifies the sender is an active participant of
an unblocked, ACTIVE match (defense-in-depth; the backend re-checks first),
clears any expired content, inserts the message, resets the 24h window, and
increments the RECIPIENT's counter — none of which can drift apart. Execute is
granted to `service_role` only (revoked from `public`/`authenticated`): normal
users always send through the backend, where the sender is resolved from the
bearer token.

#### `expire_stale_conversations()`

Returns the number of expired matches cleaned. `service_role` only. Statements
inside share one transaction, so cleanup is atomic.

### Row Level Security (messaging slice)

RLS is enabled on `messages` (deny-by-default). Policies:

| Table | Policies |
| --- | --- |
| `messages` | `SELECT` for `authenticated` only when the caller (via `profiles.auth_user_id`) is a participant of the message's match AND that match is still ACTIVE (`unmatched_at IS NULL`), no active block in either direction, and the conversation is **not expired**. **No INSERT/UPDATE/DELETE policies.** |

Supporting behavior:

- Normal users hold a SELECT grant only on `messages` (plus the implicit
  participant policy); `anon` has no grants. Unread counters are
  backend-managed: normal users hold no UPDATE grant on `matches`.
- Unmatch semantics: because the SELECT policy filters on
  `unmatched_at IS NULL`, an unmatch cuts read access off immediately while
  the rows are retained for future safety/retention needs.
- Expiry semantics: the same policy filters on the 24h window, so expired
  messages vanish from the participants' view at the same instant — the two
  mechanisms are indistinguishable from the caller's side.
- The partner's verification status is NOT re-checked on messaging access —
  matches only ever form between VERIFIED participants; the CALLER's
  verification gate lives in the backend (403), not in these policies.

### Testing (messaging slice)

The shared harness (`supabase/tests/`) covers, for this slice: the trimmed
1..2000 body CHECK (2000 accepted, 2001 rejected), participant-only SELECT
for ACTIVE, unblocked, **non-expired** matches (nonparticipants, anon, and
lapsed conversations see nothing), immutability (no INSERT/UPDATE/DELETE path
for normal users, counters not writable either), the send RPC's recipient-only
counter increments in both directions, the RPC's participant + active-match +
no-block enforcement (nonparticipant, unmatched, and blocked senders refused,
nothing inserted), the expiry reset (send-after-expiry deletes old messages
first, zeroes stale counters, and old content never reappears), the cleanup
function's **24h** window and its refusal to delete messages pinned by an
`OPEN` report (those are marked expired and hidden from participants),
service-role-only EXECUTE, immediate inaccessibility after unmatch (with
rows retained and access restorable), the keyset and expiry indexes, and
match-deletion cascading messages away.

## Implemented — safety & moderation slice (blocks + reports)

### Tables

#### `blocks` — one reversible blocker → blocked pair

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `blocker_profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `blocked_profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `created_at` | timestamptz NOT NULL | default `now()` |

- `CHECK (blocker_profile_id <> blocked_profile_id)` rejects self-blocks.
- `UNIQUE (blocker_profile_id, blocked_profile_id)` makes duplicates
  impossible; the backend treats a duplicate insert as an idempotent re-block
  and returns the existing row.
- **Blocking never deletes a match.** It is a pure visibility filter, so
  unblocking restores exactly what was hidden. Rows are retained throughout.
- Index: `blocks_blocked_profile_id_idx` (reverse-direction lookups).

#### `reports` — reporter, target, reason, optional content reference

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `reporter_profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `reported_profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `reason` | text NOT NULL | CHECK: `harassment` / `inappropriate_content` / `fake_profile` / `underage` / `spam` / `other` |
| `detail` | text NULL | trimmed, ≤ 1000 chars when present |
| `content_type` | text NULL | CHECK: `profile` / `message` / `photo` / `opportunity` when present |
| `content_id` | uuid NULL | **no FK** — a deleted message/photo must not destroy the report's reference |
| `status` | text NOT NULL | default `OPEN`; CHECK: `OPEN` / `REVIEWED` / `DISMISSED` |
| `created_at` | timestamptz NOT NULL | default `now()` |

- `CHECK (reporter_profile_id <> reported_profile_id)` rejects self-reports.
- The content reference is nullable **as a pair**: `(content_type IS NULL) =
  (content_id IS NULL)`.
- Duplicate reports are allowed — report volume per target is admin signal, not
  an error.
- **No automatic consequence follows from a report**: no auto-block, unmatch,
  or matching effect. Admin review decides any action.
- Indexes: `reports_reported_profile_id_idx`, `reports_status_created_idx`.

### Function

#### `pair_is_blocked(profile_a uuid, profile_b uuid)` → boolean

`SECURITY DEFINER`, locked `search_path`, `stable`. Answers exactly one
question: "is there a block between these two profiles, in **either**
direction?" — nothing else about `blocks` is observable through it.

It exists because RLS policy subqueries on `blocks` would inherit `blocks`' own
RLS, and the **blocked** side has no read policy; without the definer function
the exclusion could never apply to the blocked user. Execute is granted to
`authenticated` (and separately to `service_role`), revoked from `public`.

### Row Level Security

| Table | Policies |
| --- | --- |
| `blocks` | `blocks_insert_own` — the blocker resolves to the caller's own profile, is VERIFIED, and the target is a VERIFIED profile. `blocks_select_own_outgoing` — the caller reads only their own outgoing rows. `blocks_delete_own` — owner-only unblock. **No UPDATE policies** (a block never changes target or direction). |
| `reports` | `reports_insert_own` — the reporter resolves to the caller's own profile and is VERIFIED. `reports_select_staff` — staff only. **No UPDATE/DELETE policies.** |

- The blocked user has **no read path in either direction**: a block must never
  leak to its target, so there is no SELECT policy that reveals them and the
  backend never surfaces the relationship to the blocked side.
- Report contents are **admin-only**: there is deliberately no user SELECT
  policy, so even the reporter cannot read rows back and the table can never
  become a leak or probe channel.
- Privileges: `blocks` gets `SELECT, INSERT, DELETE` for `authenticated`
  (`REVOKE ALL` from `anon`); `reports` gets `INSERT, SELECT` for
  `authenticated` (`REVOKE ALL` from `anon`). Status transitions are
  service-role only.

### Block integration across the other slices

A block is enforced in three independent places, so removing it restores
everything automatically:

- `matches_select_participant` gains `NOT pair_is_blocked(user_a_id,
  user_b_id)` — the match row becomes invisible to both participants, rows
  retained.
- `messages_select_participant` requires an unblocked active match through the
  same helper.
- `dating_actions_insert_own` refuses actions across an active block
  (defense-in-depth behind the backend's 404).
- `send_conversation_message` refuses to send across an active block; it
  surfaces through the same "not an active participant" error the backend
  already maps to 404.

## Implemented — VERIFIED-gate discovery slice

No new tables. This slice adds the two boolean gate helpers the discovery and
opportunity feeds depend on, plus the cross-user read policies that make other
people's public profile rows visible at all.

### Functions

| Function | Returns | Purpose |
| --- | --- | --- |
| `public.is_profile_verified(profile_id uuid)` | boolean | `true` only when the profile's **latest** submission (ordered `submitted_at desc`) is `VERIFIED`. `false` for `PENDING`, `REJECTED`, no submissions, or a nonexistent profile. |
| `public.is_current_user_verified()` | boolean | Resolves the caller's own profile from `auth.uid()` (never client input) and evaluates the same gate. |

Both are `SECURITY DEFINER` with `set search_path = ''`. They are `stable`,
reveal **only a boolean**, and never return a status string — an arbitrary
authenticated caller can learn "verified or not" for a profile, but never
`PENDING`/`REJECTED` directly and never the submission rows themselves (RLS
still hides those).

`is_current_user_verified()` is deliberately separate: a `profiles` policy that
subqueried `profiles` would trip PostgreSQL's "infinite recursion detected in
policy" (42P17).

Privileges: execute is granted to `authenticated` and revoked from `public`
(so `anon` cannot probe verification state at all).

### Row Level Security (cross-user read)

| Table | Policy added |
| --- | --- |
| `profiles` | `profiles_select_verified` — `is_profile_verified(id) AND is_current_user_verified()` |
| `profile_photos` | `profile_photos_select_verified` — both sides of the gate on the owning profile |
| `profile_interests` | `profile_interests_select_verified` — both sides of the gate on the owning profile |

Every policy requires **both** sides: a VERIFIED viewer gains no cross-read
access, and an unverified profile's rows are never readable by anyone else.
Owner-only SELECT policies from the core schema remain intact, so an unverified
owner still reads their own rows.

This closes the core slice's "cross-user policies arrive later" note: they are
here, gated on verification. The opportunity feed adds one further narrowing
that RLS cannot express — the candidate pool is the set of `APPLIED`
applicants of the same opportunity, enforced in the backend.

## Implemented — category & activity catalog slice

### Tables

#### `categories` — opportunity categories (reference data, admin-managed)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `name` | text NOT NULL | trimmed, 1–60 chars |
| `slug` | text NOT NULL | trimmed, 1–60 chars |
| `icon` | text NULL | optional display glyph |
| `sort_order` | integer NOT NULL | default `0`, `>= 0`; admins reorder the catalog |
| `is_active` | boolean NOT NULL | default `true`; enable/disable without deleting |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

#### `activities` — activities within a category

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `category_id` | uuid NOT NULL | FK → `categories(id)` **ON DELETE CASCADE** |
| `name` | text NOT NULL | trimmed, 1–60 chars |
| `slug` | text NOT NULL | trimmed, 1–60 chars |
| `sort_order` | integer NOT NULL | default `0`, `>= 0` |
| `is_active` | boolean NOT NULL | default `true` |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

- The catalog is **data-driven**: admins create, rename, reorder, enable/disable,
  and move an activity between categories (by updating `category_id`) with no
  schema or frontend change.
- Case-insensitive unique indexes `categories_name_lower_key` /
  `categories_slug_key` prevent obvious duplicates (`Sports` vs `sports`) while
  preserving display casing. Activity uniqueness is **per category**
  (`activities_category_name_lower_key`, `activities_category_slug_key`), so
  `Movies` may exist under both Social and Entertainment but not twice under
  the same category.
- Index: `activities_category_id_idx`.
- Deleting a category cascades its activities. An opportunity's
  `activity_id` is `ON DELETE SET NULL`, so deleting an activity detaches it
  from opportunities rather than destroying them; an opportunity's
  `category_id` is `ON DELETE RESTRICT`, which is what makes
  `category_in_use` a real database-level guarantee.

### Row Level Security

| Table | Policies |
| --- | --- |
| `categories` | `categories_read_all` — `SELECT` for `anon, authenticated`. No mutation policies. |
| `activities` | `activities_read_all` — `SELECT` for `anon, authenticated`. No mutation policies. |

Privileges mirror `universities`/`interests`: `SELECT` only for
`anon`/`authenticated`, with explicit `REVOKE INSERT, UPDATE, DELETE`, and
`ALL` for `service_role`. Users can never modify the catalog; the Admin Console
writes through the service role. The backend re-applies the `is_active` filter
in the service layer (the service role bypasses RLS).

## Implemented — opportunities slice

### Table

#### `opportunities` — admin-created official opportunities/events

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `title` | text NOT NULL | trimmed, 1–120 chars |
| `category_id` | uuid NOT NULL | FK → `categories(id)` **ON DELETE RESTRICT** |
| `activity_id` | uuid NULL | FK → `activities(id)` **ON DELETE SET NULL** |
| `description` | text NOT NULL | default `''`, ≤ 2000 chars |
| `opportunity_date` | date NULL | |
| `start_time` / `end_time` | time NULL | `end_time > start_time` when both are set |
| `location` | text NULL | trimmed, 1–200 chars when present |
| `cover_image_url` | text NULL | trimmed, ≤ 1024 chars when present |
| `capacity` | integer NULL | `> 0` when present — **informational only**; nothing enforces it |
| `partner_requirement` | text NULL | trimmed, 1–200 chars when present |
| `status` | text NOT NULL | default `DRAFT`; CHECK: `DRAFT` / `PUBLISHED` / `PAUSED` / `CANCELLED` / `EXPIRED` |
| `expiry` | timestamptz NULL | must be after `created_at`; admin-only field |
| `created_by` | uuid NULL | FK → `staff_admins(auth_user_id)` **ON DELETE SET NULL**; the staff identity, server-derived |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

- Admin-created opportunities are the **primary source of partner-finding
  activities**: users discover and join them; they never create partner
  listings themselves.
- The `status` CHECK is the database's value-set authority. The transition
  rules (`PUBLISH` from any non-terminal state; `PAUSE`/`CANCEL`/`EXPIRE` only
  from `PUBLISHED`; `CANCELLED` terminal) live in the backend service layer.
- Indexes: `opportunities_status_idx`, `opportunities_category_id_idx`,
  `opportunities_activity_id_idx`.
- Deleting an opportunity cascades to `applications`, and to
  `dating_actions`/`matches` through their `opportunity_id` foreign keys.

### Row Level Security

| Table | Policies |
| --- | --- |
| `opportunities` | `opportunities_select_published` — `SELECT` for `anon, authenticated` **only where `status = 'PUBLISHED'`**. No INSERT/UPDATE/DELETE policies. |

Drafts are invisible to users even without a session, and normal users hold no
write grants at all (`REVOKE INSERT, UPDATE, DELETE`); every state change runs
through the service role after FastAPI checks staff authorization. The backend
re-applies the `PUBLISHED` filter server-side, so a draft or paused id returns
the same 404 as an unknown id — no existence leak.

## Implemented — applications slice

#### `applications` — a user's participation in an opportunity

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `opportunity_id` | uuid NOT NULL | FK → `opportunities(id)` ON DELETE CASCADE |
| `profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `status` | text NOT NULL | default `APPLIED`; CHECK: exactly `APPLIED` / `WITHDRAWN` |
| `created_at` / `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

- **The profile is never duplicated.** An application references the existing
  profile and the opportunity and stores only participation state — there is no
  per-opportunity profile anywhere in the schema.
- `UNIQUE (opportunity_id, profile_id)` makes a second application for the
  same user and opportunity impossible at the database level.
- Withdrawing is a **status transition**, never a row deletion; re-applying is
  an UPDATE of the same row.
- Indexes: `applications_profile_id_idx` ("my activity") and
  `applications_opportunity_id_idx` (admin queues).

### Row Level Security

| Table | Policies |
| --- | --- |
| `applications` | `applications_select_own` — the caller reads only rows whose `profile_id` resolves to `auth.uid()`. `applications_insert_own` — the caller applies with their own profile, is VERIFIED, and the opportunity is `PUBLISHED`. `applications_update_own` — the caller may update (withdraw) only their own rows. **No DELETE policies.** |

Privileges: `REVOKE ALL` from `anon`; `SELECT, INSERT, UPDATE` for
`authenticated` with `DELETE` explicitly revoked. The opportunity subquery in
the INSERT policy inherits `opportunities`' RLS (authenticated may read
PUBLISHED rows), so the check evaluates correctly for the caller. Staff read
applications through the service role.

## Implemented — contextual matching slice

Additive changes only; no existing row is rewritten and no table is dropped.
Legacy actions and matches keep `opportunity_id IS NULL`.

- `dating_actions.opportunity_id` (nullable FK → `opportunities(id)` ON DELETE
  CASCADE) and `matches.opportunity_id` (same). Every new write sets it.
- `dating_actions_actor_target_opportunity_unique` and
  `matches_pair_opportunity_unique`: partial unique indexes on
  `(actor, target, opportunity_id)` / `(user_a, user_b, opportunity_id)`
  `WHERE opportunity_id IS NOT NULL`. Legacy rows (`NULL`) are unaffected and
  carry no uniqueness guarantee, which is acceptable because the product always
  writes with an opportunity.
- `matches_user_a_id_idx` added to preserve the lookup path the dropped
  `matches_pair_unique` index used to serve.
- `dating_actions_insert_own` was dropped and recreated to also require
  `opportunity_id IS NOT NULL` and a **PUBLISHED** opportunity. This is
  defense-in-depth behind the backend, which independently enforces
  participation, verification, block state, and target eligibility.
- `matches_select_participant` is unchanged: participants may read the whole
  row (including `opportunity_id`), still only when not blocked. There are no
  user write policies on `matches`.

Consequences: the same two profiles can hold one action and one match **per
opportunity**, and nothing leaks across opportunity contexts — the candidate
pool for an opportunity is that opportunity's `APPLIED` applicants.

## Implemented — suspensions & report opportunity context

### Table

#### `suspensions` — one row per admin-issued account suspension

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | default `gen_random_uuid()` |
| `profile_id` | uuid NOT NULL | FK → `profiles(id)` ON DELETE CASCADE |
| `reason` | text NOT NULL | trimmed, 1–500 chars |
| `suspended_until` | timestamptz NULL | NULL = indefinite; otherwise must be after `created_at` |
| `created_by` | uuid NOT NULL | FK → `staff_admins(auth_user_id)` **ON DELETE RESTRICT** |
| `created_at` | timestamptz NOT NULL | default `now()` |

- An indefinite block is exactly a suspension with `suspended_until IS NULL`, so
  the admin console needs one moderation model, not two.
- Lapsed timed suspensions are simply rows whose `suspended_until` is in the
  past; they are ignored and need no cleanup job.
- Index: `suspensions_profile_id_idx`.

### Row Level Security

RLS enabled with **deliberately no policies**: `REVOKE ALL` from
`anon, authenticated`, `ALL` for `service_role`. There is no user SELECT path —
a suspended user must not learn who suspended them or why beyond what the
backend surfaces through its own API. Enforcement (making a suspended account
read-only) is **backend logic** in one place, applied before any handler runs.

### `reports.content_type`

The CHECK was swapped to widen the accepted value set from
`profile` / `message` / `photo` to include `opportunity`, so a report can
reference an opportunity as well as a profile/message/photo. The pair
constraint (`(content_type IS NULL) = (content_id IS NULL)`) is unchanged, and
there is still **no foreign key** on `content_id`: a deleted message or photo
must not destroy the report's reference. (The public `POST /reports` route
accepts only `profile`/`message`/`photo`; `opportunity` is reachable from the
admin surface.)

## Requirements for future slices (NOT implemented yet)

The entities below remain **requirements only** — do not treat them as
existing tables. Everything above is implemented.

### Messaging (future-phase additions)

- **Realtime transport** — Supabase Realtime channels for live message
  delivery, presence, and ephemeral typing indicators (v1 polls instead);
  nothing here is persisted.
- **Read receipts** — per-message delivered/read states (v1 keeps one
  per-participant unread counter per conversation).
- **Attachments / rich content** — non-text message bodies and their
  storage/retention rules.

### Future-phase

- **User-created group proposals** — curated groups a user proposes and an
  admin approves before they are public. No table exists; the only opportunity
  write path today is the admin one.
- **Notifications** — in-app notification records (e.g. match made, new
  message) with per-user read state; delivery channels are post-v1.

## Cross-cutting requirements (carried forward)

- All eligibility gates (18+, `VERIFIED`) resolvable by both FastAPI and RLS
  policies without N+1 fan-out. Verification status is derived from a single
  indexed lookup over `verification_submissions`, exposed to RLS only as the
  boolean `is_profile_verified` / `is_current_user_verified` helpers — never as
  a status string, so no caller can probe arbitrary profiles' states.
- Deletion propagation: removing an account cascades/anonymizes across
  profiles, photos, verifications, applications, actions, blocks, reports,
  suspensions, matches, and messages consistent with retention rules. Verified
  cascades: `auth.users → profiles → photos/interests/applications/actions/
  matches/blocks/reports/suspensions`, `verification_submissions → audit
  records`, `opportunities → applications/actions/matches`, `categories →
  activities`.
- `RESTRICT` is used deliberately where an audit or attribution trail must not
  disappear: `staff_admins` referenced by `verification_submissions`,
  `verification_reviews`, `opportunities.created_by`, and
  `suspensions.created_by`.
- Storage object references remain valid or clean up atomically with rows;
  Storage-side object deletion accompanies row deletion in the app layer.
- Verification states are exactly `PENDING`, `VERIFIED`, `REJECTED`; the
  manual admin decision is authoritative (automation never finalizes
  status).
- Student ID documents live in a private Storage bucket; the database stores
  references only, never the documents themselves.
- Blocked/report relationships must not leak identity to the targeted user —
  there is no user SELECT policy on either table that would reveal them.
- Opportunity context must never leak across opportunities: the candidate pool
  is the same opportunity's `APPLIED` applicants, and actions/matches are keyed
  by `(pair, opportunity)`.

### Known limitations & deferred decisions (verification slice)

- **No user-side withdrawal.** A user cannot delete/cancel their own
  `PENDING` submission (no DELETE grant); a mistaken upload is unblocked by
  a reviewer rejection + resubmission. A "withdraw" flow is a product
  decision, not yet taken.
- **Audit retention after account deletion.** Audit records cascade away
  with the account; SECURITY.md's minimized-retention rule (TBD) will need
  either an archival design or a documented exception.
- **Reviewer identity is hard-locked.** Staff accounts with recorded
  decisions cannot be deleted (RESTRICT FKs); departed reviewers should have
  their auth account disabled instead. Anonymization of departed-staff
  audit entries is TBD.
- **Suspension enforcement is backend-side only.** The database stores and
  protects suspension rows but cannot refuse requests; the read-only gate for a
  suspended account lives in one FastAPI dependency. A direct client using the
  anon key against a table with no user SELECT policy is still constrained by
  RLS, but the gate is not a database object.
- **`capacity` is unenforced.** `opportunities.capacity` is validated as a
  positive integer but nothing closes applications at the limit; managing the
  participant list is a product decision.
- **Conversation expiry cleanup requires `pg_cron`.** The 24h migration tries
  to enable it automatically and **aborts** if the extension cannot be created
  or the cleanup job cannot be scheduled. Enable `pg_cron` once in the
  Dashboard (or with `create extension pg_cron with schema pg_catalog;`), then
  rerun the migration. Confirm the job in `cron.job` and recent runs in
  `cron.job_run_details` (queries above).
- **Legacy `NULL` opportunity rows.** Actions and matches created before the
  contextual-matching slice keep `opportunity_id IS NULL` and therefore carry
  no per-opportunity uniqueness guarantee. They remain valid and readable; the
  product no longer creates them.
