# UniMatch — Database

> Status: **Core schema slice implemented** (`universities`, `profiles`,
> `interests`, `profile_interests`, `profile_photos` — migration
> `20260827120000_core_schema.sql`), **student-ID verification slice
> implemented** (`staff_admins`, `verification_submissions`,
> `verification_reviews` — migration `20260827130000_verification.sql`), and
> **profile-photo Storage implemented** (private `profile-photos` bucket —
> migration `20260827150000_profile_photos_storage.sql`). Dating, matching,
> messaging, safety, and notification tables are **not yet implemented**;
> the requirements for those remain design targets in this document.

## How the schema is managed

- PostgreSQL via Supabase; migrations live in `supabase/migrations/` and are
  applied with the Supabase CLI. Exactly three migrations exist so far
  (`20260827120000_core_schema.sql`, `20260827130000_verification.sql`,
  `20260827140000_verification_storage.sql`,
  `20260827150000_profile_photos_storage.sql`); later slices do **not**
  modify earlier migrations.
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
  and "primary = lowest position" are product rules enforced by the
  photo-management slice **in the backend service layer** (max count on
  upload; `is_primary` re-derived from `position` on every mutation). The
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
- the future VERIFIED-gate check for discovery-era RLS policies will be
  designed with that slice and must reveal no more than the PRD's "verified"
  indicator — never arbitrary-profile statuses.

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

## Requirements for future slices (NOT implemented yet)

The entities below remain **requirements only** — do not treat them as
existing tables. (Verification and its audit trail are implemented above.)

### Dating core

6. **Likes** — actor → target action records used both for discovery
   exclusion and mutual-match detection. A pair cannot accumulate
   conflicting/duplicate active likes (exact constraint TBD).
7. **Passes** — actor → target "decline" records excluding targets from the
   feed. v1 treats passes as final (open question in PRD).
8. **Matches** — created when two eligible users mutually like each other;
   unordered participant pair with at-most-one-active-match dedupe;
   visibility limited to participants; tracks unmatched state.
9. **Conversations** — message containers for matches (likely 1:1 with an
   active match; final modeling TBD).
10. **Messages** — text messages within conversations: sender (participant),
    server-assigned timestamp/conversation ordering; participants-only
    readability enforced by policy; inaccessible after unmatch/block while
    retained per safety/retention rules. Typing indicators are **not**
    persisted (ephemeral via Realtime).

### Safety

11. **Blocks** — blocker → blocked pairs; drives discovery exclusion and
    messaging lockout in both directions of effect; reversible on unblock.
12. **Reports** — reporter, reported user, optional content reference,
    reason category, free-text detail, processing status for the admin
    workflow. Contents visible only to admins.

### Future-phase

13. **Notifications** — in-app notification records (e.g., match made, new
    message) with per-user read state; delivery channels are post-v1.

## Cross-cutting requirements (carried forward)

- All eligibility gates (18+, `VERIFIED`) resolvable by both FastAPI and RLS
  policies without N+1 fan-out — the verification slice keeps status
  derivation to a single indexed lookup over `verification_submissions`; the
  VERIFIED-gate helper for discovery-era policies lands with discovery and
  must be designed so it cannot reveal arbitrary-profile statuses to normal
  users (no such helper exists today).
- Deletion propagation: removing an account cascades/anonymizes across
  profiles, photos, verifications, likes, passes, matches, conversations,
  messages consistent with retention rules (TBD). The core slice already
  cascades `auth.users → profiles → photos/interests`, and the verification
  slice cascades `profiles → submissions → audit records`.
- Storage object references remain valid or clean up atomically with rows;
  Storage-side object deletion accompanies row deletion in the app layer.
- Verification states are exactly `PENDING`, `VERIFIED`, `REJECTED`; the
  manual admin decision is authoritative (automation never finalizes
  status).
- Student ID documents live in a private Storage bucket; the database stores
  references only, never the documents themselves.
- Blocked/report relationships must not leak identity to the targeted user.

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
- **VERIFIED-gate helper is deferred.** No user-callable status helper
  exists — arbitrary-profile status disclosure was deliberately removed from
  the design. When the discovery slice lands, its gate check must reveal no
  more than the PRD's "verified" indicator.
