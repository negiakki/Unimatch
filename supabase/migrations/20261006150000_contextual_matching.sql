-- ============================================================================
-- UniMatch — Contextual matching slice
--
-- Makes actions and matches opportunity-scoped so the SAME two users can
-- connect independently through DIFFERENT opportunities (e.g. Akshat ↔ Rahul
-- for Dandiya Night, and separately Akshat ↔ Rahul for Badminton Tournament).
--
-- Adds:
--   * dating_actions.opportunity_id — nullable FK (legacy rows predate
--     opportunities); all new writes set it. The old UNIQUE(actor, target)
--     constraint is dropped because it would prevent the same pair from
--     acting across different opportunities. A PARTIAL unique index on
--     (actor, target, opportunity_id) WHERE opportunity_id IS NOT NULL keeps
--     "one action per pair per opportunity" while leaving legacy rows
--     untouched.
--   * matches.opportunity_id — same pattern. The old UNIQUE(user_a, user_b)
--     is dropped; a partial unique index on (user_a, user_b, opportunity_id)
--     WHERE opportunity_id IS NOT NULL allows independent matches in
--     different opportunities while preventing duplicates within one.
--   * dating_actions_insert_own is recreated to require the target
--     opportunity to be PUBLISHED (defense-in-depth behind the backend).
--
-- Existing rows are preserved (opportunity_id stays NULL for them); no data
-- is rewritten or deleted. Existing migrations are untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- dating_actions.opportunity_id — scope each action to an opportunity.
-- ---------------------------------------------------------------------------
alter table public.dating_actions
  add column opportunity_id uuid;

alter table public.dating_actions
  add constraint dating_actions_opportunity_id_fkey
    foreign key (opportunity_id) references public.opportunities (id)
    on delete cascade;

-- The old UNIQUE(actor, target) would forbid the same pair from acting in two
-- different opportunities. It is replaced by the partial unique index below;
-- legacy rows (opportunity_id IS NULL) retain no uniqueness guarantee, which
-- is acceptable since the new product always writes with an opportunity.
alter table public.dating_actions
  drop constraint dating_actions_actor_target_unique;

-- One action per (actor, target, opportunity) — the contextual equivalent of
-- the old pair-level constraint. Partial on opportunity_id so legacy rows
-- (NULL) are unaffected.
create unique index dating_actions_actor_target_opportunity_unique
  on public.dating_actions (actor_profile_id, target_profile_id, opportunity_id)
  where opportunity_id is not null;

-- ---------------------------------------------------------------------------
-- matches.opportunity_id — scope each match to an opportunity.
-- ---------------------------------------------------------------------------
alter table public.matches
  add column opportunity_id uuid;

alter table public.matches
  add constraint matches_opportunity_id_fkey
    foreign key (opportunity_id) references public.opportunities (id)
    on delete cascade;

-- Same drop/replacement: UNIQUE(user_a, user_b) would forbid the same pair
-- matching in two different opportunities. Legacy matches (opportunity_id
-- NULL) are preserved unchanged.
alter table public.matches
  drop constraint matches_pair_unique;

-- One match per (pair, opportunity): the concurrency arbiter for the new
-- contextual matching. Partial on opportunity_id so legacy matches (NULL)
-- remain valid.
create unique index matches_pair_opportunity_unique
  on public.matches (user_a_id, user_b_id, opportunity_id)
  where opportunity_id is not null;

-- Preserve the user_a lookup path the dropped unique index used to serve (its
-- user_b counterpart already exists as matches_user_b_id_idx).
create index matches_user_a_id_idx on public.matches (user_a_id);

-- ---------------------------------------------------------------------------
-- RLS: actions now also require a PUBLISHED opportunity. The opportunity
-- subquery inherits opportunities' RLS (authenticated can read PUBLISHED
-- rows), so it evaluates correctly for the caller.
-- ---------------------------------------------------------------------------
drop policy "dating_actions_insert_own" on public.dating_actions;
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
    and not public.pair_is_blocked(actor_profile_id, target_profile_id)
    and opportunity_id is not null
    and exists (
      select 1 from public.opportunities o
      where o.id = opportunity_id
        and o.status = 'PUBLISHED'
    )
  );

-- matches_select_participant is unchanged: participants may read the whole
-- row (including the new opportunity_id column), still only when not
-- blocked. There are no user write policies for matches.
