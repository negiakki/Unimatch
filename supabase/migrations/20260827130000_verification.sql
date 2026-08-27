-- ============================================================================
-- UniMatch — Student ID verification slice
--
-- Creates: staff_admins, verification_submissions, verification_reviews
--
-- Workflow (manual review is authoritative; states are exactly
-- PENDING / VERIFIED / REJECTED):
--
--   (no submissions)        -> PENDING   (owner submits; new row)
--   PENDING -> VERIFIED                 (staff decision; auto-audited)
--   PENDING -> REJECTED                 (staff decision; reason required)
--   REJECTED -> PENDING                 (resubmission = NEW submission row;
--                                        decided rows are immutable)
--   VERIFIED is terminal — a verified profile cannot submit again.
--
-- Notes:
--   * Targets Supabase PostgreSQL; reuses the existing profiles/auth.users
--     relationships. No credentials live in this file.
--   * The ID document is NEVER stored in PostgreSQL: only a private Storage
--     object path reference (no bucket, upload, or URL logic here).
--   * RLS is enabled on every new table, deny-by-default. Normal users can
--     only insert/read submissions for their OWN profile; ownership is always
--     derived from auth.uid() through profiles — never from client input.
--   * Decisions are privileged (service role via the backend, which checks
--     reviewer authorization first) and every decision automatically writes
--     an append-only audit record via trigger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- staff_admins — registry of accounts authorized to act as reviewers.
--
-- v1 has a single trusted admin; more moderators are added by inserting rows.
-- The reviewer foreign keys below point here, so an "invalid reviewer" (any
-- auth user who is not registered staff) is impossible at the FK level.
-- ---------------------------------------------------------------------------
create table public.staff_admins (
  auth_user_id uuid primary key,
  created_at   timestamptz not null default now(),

  -- A staff account is a real Supabase Auth identity. Deleting the auth user
  -- removes the staff row (unless review records still reference it — see the
  -- RESTRICT foreign keys on the verification tables).
  constraint staff_admins_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users (id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- verification_submissions — one row per student-ID submission.
--
-- A submission belongs to exactly one profile; a profile accumulates an
-- auditable history of submissions. The current verification state is the
-- status of the most recent submission (never duplicated on profiles).
-- ---------------------------------------------------------------------------
create table public.verification_submissions (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null,
  status           text not null default 'PENDING',
  storage_path     text not null,
  submitted_at     timestamptz not null default now(),
  reviewed_at      timestamptz,
  reviewer_id      uuid,
  rejection_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Submissions die with the profile (account deletion cascades; Storage
  -- object cleanup remains an application responsibility).
  constraint verification_submissions_profile_id_fkey
    foreign key (profile_id) references public.profiles (id) on delete cascade,

  -- Only registered staff can be recorded as reviewers; a staff member who
  -- has made decisions cannot be hard-deleted (audit integrity).
  constraint verification_submissions_reviewer_id_fkey
    foreign key (reviewer_id) references public.staff_admins (auth_user_id)
    on delete restrict,

  -- Private Storage object reference: no binaries, no URLs. One row per
  -- Storage object.
  constraint verification_submissions_storage_path_key unique (storage_path),
  constraint verification_submissions_storage_path_valid check (
    storage_path = btrim(storage_path)
    and char_length(storage_path) between 1 and 1024
  ),

  -- States are exactly PENDING / VERIFIED / REJECTED.
  constraint verification_submissions_status_valid check (
    status in ('PENDING', 'VERIFIED', 'REJECTED')
  ),

  -- A PENDING row carries no review facts yet.
  constraint verification_submissions_pending_fields_clean check (
    status <> 'PENDING'
    or (reviewer_id is null and reviewed_at is null and rejection_reason is null)
  ),

  -- A decided row always records who and when.
  constraint verification_submissions_decided_fields_present check (
    status = 'PENDING'
    or (reviewer_id is not null and reviewed_at is not null)
  ),

  -- Rejection reason exists (trimmed, 1-500 chars) iff status is REJECTED.
  constraint verification_submissions_rejection_reason_valid check (
    (status = 'REJECTED')
    = (rejection_reason is not null
       and rejection_reason = btrim(rejection_reason)
       and char_length(rejection_reason) between 1 and 500)
  )
);

-- At most one ACTIVE PENDING submission per profile; rejected/verified
-- history is unaffected and remains auditable. Enforced under concurrency.
create unique index verification_submissions_one_pending_per_profile_idx
  on public.verification_submissions (profile_id) where status = 'PENDING';

-- Serves "latest submission decides the current state" lookups.
create index verification_submissions_profile_submitted_idx
  on public.verification_submissions (profile_id, submitted_at desc);

-- Serves the reviewer queue (oldest pending first).
create index verification_submissions_status_submitted_idx
  on public.verification_submissions (status, submitted_at);

-- ---------------------------------------------------------------------------
-- verification_reviews — append-only audit trail of review decisions.
--
-- Rows are written ONLY by the decision trigger on verification_submissions,
-- so an audit record exists for every decision and can never be skipped.
-- Normal users hold no write privilege and no RLS policy; staff can read.
-- ---------------------------------------------------------------------------
create table public.verification_reviews (
  id               uuid primary key default gen_random_uuid(),
  submission_id    uuid not null,
  reviewer_id      uuid not null,
  decision         text not null,
  rejection_reason text,
  created_at       timestamptz not null default now(),

  -- Audit records follow their submission through account deletion
  -- (minimized-retention rules remain a documented product TBD).
  constraint verification_reviews_submission_id_fkey
    foreign key (submission_id)
    references public.verification_submissions (id) on delete cascade,

  constraint verification_reviews_reviewer_id_fkey
    foreign key (reviewer_id) references public.staff_admins (auth_user_id)
    on delete restrict,

  constraint verification_reviews_decision_valid check (
    decision in ('VERIFIED', 'REJECTED')
  ),
  constraint verification_reviews_rejection_reason_valid check (
    (decision = 'REJECTED')
    = (rejection_reason is not null
       and rejection_reason = btrim(rejection_reason)
       and char_length(rejection_reason) between 1 and 500)
  )
);

create index verification_reviews_submission_id_idx
  on public.verification_reviews (submission_id);

create index verification_reviews_reviewer_id_idx
  on public.verification_reviews (reviewer_id);

-- ---------------------------------------------------------------------------
-- State machine enforcement (triggers).
--
-- SECURITY DEFINER with a locked search_path so invariants hold regardless of
-- the calling role; fully qualified names throughout.
-- ---------------------------------------------------------------------------
create or replace function public.verification_submissions_prepare_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
begin
  caller := auth.uid();

  -- Defense-in-depth pre-check mirroring the INSERT policy: a claim-bearing
  -- caller may only submit for their OWN profile (ownership derived from
  -- auth.uid() via profiles — never trusted from client input). This runs
  -- before the RLS WITH CHECK evaluation, so failure must be indistinguishable
  -- from an RLS denial; business-rule errors below would otherwise leak
  -- another profile's verification state through error timing/messages.
  if caller is not null then
    if not exists (
      select 1 from public.profiles p
      where p.id = new.profile_id
        and p.auth_user_id = caller
    ) then
      raise exception
        'new row violates row-level security policy for table "verification_submissions"'
        using errcode = '42501';
    end if;
  end if;
  -- Callers without an auth claim (service role / maintenance) skip the
  -- ownership pre-check; `anon` cannot reach this trigger at all because it
  -- holds no INSERT privilege on the table.

  -- Submissions are born PENDING; decisions happen only through UPDATE, which
  -- always writes an audit record.
  if new.status is distinct from 'PENDING' then
    raise exception 'verification submissions must be created in state PENDING'
      using errcode = '23514';
  end if;

  -- Server-authoritative facts: the client never chooses when a submission
  -- happened, nor any review-related field.
  new.submitted_at := clock_timestamp();
  new.reviewer_id := null;
  new.reviewed_at := null;
  new.rejection_reason := null;

  -- VERIFIED is terminal: no further submissions for a verified profile.
  if exists (
    select 1 from public.verification_submissions v
    where v.profile_id = new.profile_id
      and v.status = 'VERIFIED'
  ) then
    raise exception
      'this profile is already VERIFIED; further verification submissions are not allowed'
      using errcode = '23514';
  end if;

  -- Friendly (non-concurrent) duplicate check; the partial unique index
  -- remains the hard guarantee under concurrency.
  if exists (
    select 1 from public.verification_submissions v
    where v.profile_id = new.profile_id
      and v.status = 'PENDING'
  ) then
    raise exception
      'a PENDING verification submission already exists for this profile'
      using errcode = '23505';
  end if;

  return new;
end;
$$;

create or replace function public.verification_submissions_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'verification submissions cannot change their id'
      using errcode = '23514';
  end if;
  if new.profile_id is distinct from old.profile_id then
    raise exception 'verification submissions cannot change profile'
      using errcode = '23514';
  end if;
  if new.storage_path is distinct from old.storage_path then
    raise exception 'the submitted document reference is immutable'
      using errcode = '23514';
  end if;

  -- Submission facts are immutable.
  new.created_at := old.created_at;
  new.submitted_at := old.submitted_at;

  -- No status change: review fields may not move on their own.
  if new.status is not distinct from old.status then
    if new.reviewer_id is distinct from old.reviewer_id
       or new.reviewed_at is distinct from old.reviewed_at
       or new.rejection_reason is distinct from old.rejection_reason then
      raise exception
        'review fields may only change as part of a status decision'
        using errcode = '23514';
    end if;
    return new;
  end if;

  -- Status changed: the only legal transition is PENDING -> VERIFIED|REJECTED.
  -- Decided rows are immutable; there is no VERIFIED/REJECTED -> anything.
  if old.status <> 'PENDING'
     or new.status is null
     or (new.status <> 'VERIFIED' and new.status <> 'REJECTED') then
    raise exception 'illegal verification status transition: % -> %',
      old.status, coalesce(new.status, 'NULL')
      using errcode = '23514';
  end if;

  if new.reviewer_id is null then
    raise exception 'a verification decision requires a reviewer'
      using errcode = '23514';
  end if;

  -- Decision time is server-assigned, never client-supplied.
  new.reviewed_at := clock_timestamp();

  if new.status = 'REJECTED' then
    if new.rejection_reason is null
       or new.rejection_reason <> btrim(new.rejection_reason)
       or char_length(new.rejection_reason) not between 1 and 500 then
      raise exception
        'a REJECTED decision requires a rejection reason (1-500 characters after trimming)'
        using errcode = '23514';
    end if;
  else
    new.rejection_reason := null;
  end if;

  return new;
end;
$$;

-- Every decision automatically produces its audit record; a status change
-- without an audit row is structurally impossible.
create or replace function public.verification_submissions_record_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> new.status
     and (new.status = 'VERIFIED' or new.status = 'REJECTED') then
    insert into public.verification_reviews
      (submission_id, reviewer_id, decision, rejection_reason)
    values
      (new.id, new.reviewer_id, new.status, new.rejection_reason);
  end if;
  return null;
end;
$$;

-- Append-only guard: review records can never be rewritten or wiped through
-- any application path (including the service role). DELETE is intentionally
-- not blocked so account deletion can cascade audit records away.
create or replace function public.verification_reviews_guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'verification review records are append-only and cannot be modified'
    using errcode = '23514';
end;
$$;

create trigger verification_submissions_prepare_insert
  before insert on public.verification_submissions
  for each row execute function public.verification_submissions_prepare_insert();

create trigger verification_submissions_guard_update
  before update on public.verification_submissions
  for each row execute function public.verification_submissions_guard_update();

create trigger verification_submissions_set_updated_at
  before update on public.verification_submissions
  for each row execute function public.set_updated_at();

create trigger verification_submissions_record_decision
  after update on public.verification_submissions
  for each row execute function public.verification_submissions_record_decision();

create trigger verification_reviews_no_update
  before update on public.verification_reviews
  for each row execute function public.verification_reviews_guard_append_only();

create trigger verification_reviews_no_truncate
  before truncate on public.verification_reviews
  for each statement execute function public.verification_reviews_guard_append_only();

-- ---------------------------------------------------------------------------
-- Current verification status: DERIVED, deliberately NOT exposed to clients.
--
-- There is no denormalized status column on `profiles` and deliberately NO
-- user-callable `current_verification_status(profile_id)` helper: a SECURITY
-- DEFINER function executable by `authenticated` would let any user query
-- the verification state of ARBITRARY profiles. The current state of a
-- profile is simply the status of its most recent submission (`submitted_at`
-- is trigger-assigned from clock_timestamp(), so "most recent" is
-- server-ordered and monotonic), obtained:
--
--   * by owners, through the owner-only SELECT policy on this table;
--   * by staff, through the staff SELECT policy (review queue).
--
-- The future VERIFIED-gate check for discovery-era RLS policies must be
-- introduced with that slice and designed to reveal no more than the PRD's
-- "verified" indicator — never PENDING/REJECTED/VERIFIED for arbitrary
-- profiles.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled everywhere, deny-by-default.
-- (select auth.uid()) is wrapped in a subselect so the plan evaluates it once.
-- ---------------------------------------------------------------------------
alter table public.staff_admins              enable row level security;
alter table public.verification_submissions  enable row level security;
alter table public.verification_reviews      enable row level security;

-- Staff membership: a user can see their own staff row only (non-staff see
-- nothing). This policy is also what makes the staff SELECT policies on the
-- verification tables evaluable for real staff members.
create policy "staff_admins_select_self"
  on public.staff_admins for select to authenticated
  using (auth_user_id = (select auth.uid()));

-- Submissions: owners see and create their own; staff can read the queue
-- (including other users' submissions) for manual review. There are
-- deliberately NO update/delete policies — decisions are privileged service
-- role operations (after FastAPI checks reviewer authorization), and normal
-- users additionally hold no UPDATE/DELETE grant at all.
create policy "verification_submissions_select_own"
  on public.verification_submissions for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "verification_submissions_insert_own"
  on public.verification_submissions for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "verification_submissions_select_staff"
  on public.verification_submissions for select to authenticated
  using (
    exists (
      select 1 from public.staff_admins s
      where s.auth_user_id = (select auth.uid())
    )
  );

-- Review history: staff read-only. No insert/update/delete policies exist —
-- audit rows are written exclusively by the decision trigger, and normal
-- users hold no write grants at all.
create policy "verification_reviews_select_staff"
  on public.verification_reviews for select to authenticated
  using (
    exists (
      select 1 from public.staff_admins s
      where s.auth_user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Privileges — explicit and minimal (Supabase default privileges may grant
-- more, so everything is revoked first). RLS is the security boundary; grants
-- keep non-privileged roles from even reaching protected objects. The service
-- role bypasses RLS and performs review decisions on behalf of FastAPI, which
-- checks reviewer authorization first.
-- ---------------------------------------------------------------------------
revoke all privileges on public.staff_admins
  from anon, authenticated;
revoke all privileges on public.verification_submissions
  from anon, authenticated;
revoke all privileges on public.verification_reviews
  from anon, authenticated;

-- Submissions: users may submit and read their own; no UPDATE/DELETE grant
-- means a normal user can never change status, reviewer, or anything else.
grant select, insert on public.verification_submissions to authenticated;

-- Review history: SELECT exists only so RLS policies can evaluate staff
-- membership; RLS hides every row from non-staff. No write grants for users.
grant select on public.verification_reviews to authenticated;

-- Staff registry: SELECT for the same policy-evaluation reason.
grant select on public.staff_admins to authenticated;

grant all on public.staff_admins,
            public.verification_submissions,
            public.verification_reviews
  to service_role;
