-- ============================================================================
-- UniMatch — Phase 6 slice: likes, passes & matches
--
-- Adds:
--   * public.dating_actions — ONE table for both LIKE and PASS. Exactly one
--     immutable action per (actor, target) pair: the UNIQUE(actor, target)
--     constraint makes a LIKE after a PASS (or a PASS after a LIKE, or any
--     duplicate) impossible at the database level. Self-actions are rejected
--     by CHECK. Actions are viewer-scoped: acting on someone never affects
--     the reverse direction.
--   * public.matches — explicitly stored mutual-like matches, uniquely
--     identified by the CANONICAL ordering of the two participant profile
--     ids (user_a_id < user_b_id, enforced by CHECK). The unique pair
--     constraint is the concurrency arbiter: concurrent mutual likes
--     attempting to create the same match twice fail with a duplicate key,
--     so a pair can never hold two match rows.
--
-- Unmatching is a soft transition (`unmatched_at`): the row is retained so
-- the pair can never rematch through normal discovery, while the matches
-- list shows only active matches. Rows and columns are written only by the
-- backend's service-role client — normal users get no write path.
--
-- No existing migration is modified. Storage RLS is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- dating_actions — one immutable LIKE/PASS per (actor, target) pair.
-- ---------------------------------------------------------------------------
create table public.dating_actions (
  id                uuid primary key default gen_random_uuid(),
  actor_profile_id  uuid not null references public.profiles (id) on delete cascade,
  target_profile_id uuid not null references public.profiles (id) on delete cascade,
  action_type       text not null check (action_type in ('LIKE', 'PASS')),
  created_at        timestamptz not null default now(),
  constraint dating_actions_no_self_action check (actor_profile_id <> target_profile_id),
  constraint dating_actions_actor_target_unique unique (actor_profile_id, target_profile_id)
);

-- Feed exclusion looks up actions BY target (who already acted on the viewer)
-- as well as by actor; both directions stay indexed.
create index dating_actions_target_profile_id_idx on public.dating_actions (target_profile_id);

alter table public.dating_actions enable row level security;

-- INSERT: the actor must resolve to the caller's own profile (a client cannot
-- spoof actor_profile_id), the caller must be VERIFIED, and the target must
-- be a VERIFIED profile. Self-actions additionally fail the table CHECK.
create policy "dating_actions_insert_own"
  on public.dating_actions for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles actor
      where actor.id = actor_profile_id
        and actor.auth_user_id = (select auth.uid())
    )
    and public.is_current_user_verified()
    and public.is_profile_verified(target_profile_id)
  );

-- SELECT: the caller may read only their own OUTGOING actions (v1 needs this
-- for the already-decided check). Incoming likes/passes are never exposed —
-- there is deliberately no "who liked you" surface.
create policy "dating_actions_select_own_outgoing"
  on public.dating_actions for select to authenticated
  using (
    exists (
      select 1 from public.profiles actor
      where actor.id = actor_profile_id
        and actor.auth_user_id = (select auth.uid())
    )
  );

-- No UPDATE/DELETE policies: actions are immutable for normal users in v1.

revoke all on public.dating_actions from anon;
revoke update, delete on public.dating_actions from authenticated;
grant select, insert on public.dating_actions to authenticated;

-- ---------------------------------------------------------------------------
-- matches — explicit, canonical, deduplicated mutual-like records.
-- ---------------------------------------------------------------------------
create table public.matches (
  id            uuid primary key default gen_random_uuid(),
  user_a_id     uuid not null references public.profiles (id) on delete cascade,
  user_b_id     uuid not null references public.profiles (id) on delete cascade,
  created_at    timestamptz not null default now(),
  unmatched_at  timestamptz,
  constraint matches_canonical_pair_order check (user_a_id < user_b_id),
  constraint matches_pair_unique unique (user_a_id, user_b_id),
  constraint matches_unmatch_after_creation check (
    unmatched_at is null or unmatched_at >= created_at
  )
);

-- Participant lookup scans both sides of the pair.
create index matches_user_b_id_idx on public.matches (user_b_id);

alter table public.matches enable row level security;

-- SELECT: participants only. Nonparticipants (and anon) see nothing —
-- no existence leak for matches they are not part of.
create policy "matches_select_participant"
  on public.matches for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.auth_user_id = (select auth.uid())
        and (p.id = user_a_id or p.id = user_b_id)
    )
  );

-- No INSERT/UPDATE/DELETE policies: matches are created and unmatched only
-- by the backend's service-role atomic operation.

revoke all on public.matches from anon;
revoke insert, update, delete on public.matches from authenticated;
grant select on public.matches to authenticated;
