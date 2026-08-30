-- ============================================================================
-- UniMatch — Phase 8 slice: safety & moderation (blocks + reports)
--
-- Adds:
--   * public.blocks — one reversible blocker → blocked relationship per pair.
--     Self-blocks are rejected by CHECK; the UNIQUE(blocker, blocked)
--     constraint makes duplicate blocks impossible (the backend treats a
--     duplicate insert as an idempotent re-block and returns the existing
--     row). Blocking NEVER deletes a match: it is a pure visibility filter,
--     so unblocking restores exactly what was hidden (reversible per PRD).
--   * public.reports — reporter, reported user, fixed reason category,
--     optional free-text detail, optional (content_type, content_id) content
--     reference (no FK: a deleted message/photo must not destroy the
--     report's reference; the pair is validated together), and a processing
--     status (born OPEN; transitions are a future staff slice).
--
-- RLS is enabled on both tables, deny-by-default:
--   * blocks: the blocker may insert/select/delete ONLY their own outgoing
--     rows. The blocked user has NO read path at all — blocking is silent.
--     INSERT requires the caller to be VERIFIED and the target to be a
--     VERIFIED profile (mirrors the dating gate; VERIFIED is terminal).
--   * reports: a VERIFIED reporter may insert for their own profile. There
--     are deliberately NO user SELECT policies — report contents are
--     admin-only (SECURITY.md), so even the reporter cannot read rows back.
--     Staff read through the existing staff_admins registry.
--
-- Integration (blocks are a two-direction visibility filter):
--   * matches_select_participant / messages_select_participant gain a
--     NOT EXISTS over active blocks in either direction — a block makes the
--     match row and its conversation inaccessible IMMEDIATELY (reads too)
--     while all rows are retained, and everything is restored on unblock.
--   * dating_actions_insert_own refuses actions across an active block
--     (defense-in-depth behind the backend's 404).
--   * send_conversation_message refuses to send across an active block —
--     it surfaces through the same "not an active participant" error the
--     backend already maps to 404.
--
-- No automatic consequence follows from a report (no auto-block/unmatch).
-- No existing migration is modified. Storage RLS is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- blocks — one reversible blocker → blocked pair.
-- ---------------------------------------------------------------------------
create table public.blocks (
  id                 uuid primary key default gen_random_uuid(),
  blocker_profile_id uuid not null references public.profiles (id) on delete cascade,
  blocked_profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at         timestamptz not null default now(),

  constraint blocks_no_self_block check (blocker_profile_id <> blocked_profile_id),
  constraint blocks_blocker_blocked_unique unique (blocker_profile_id, blocked_profile_id)
);

-- Reverse-direction lookups (candidates blocked by the viewer / blocking the
-- viewer; the blocked side of match pairs).
create index blocks_blocked_profile_id_idx on public.blocks (blocked_profile_id);

-- ---------------------------------------------------------------------------
-- pair_is_blocked — SECURITY DEFINER helper (locked search_path), the RLS
-- counterpart of the backend's block filter. RLS policy subqueries on
-- `blocks` would inherit blocks' own RLS, so the BLOCKED side (which has no
-- read policy) could never observe the block and the exclusion would not
-- apply to them. This helper runs as the function owner and answers a single
-- boolean: "is there an active block between these two profiles, in either
-- direction?" — nothing else about blocks is observable through it.
-- ---------------------------------------------------------------------------
create or replace function public.pair_is_blocked(profile_a uuid, profile_b uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_profile_id = profile_a and b.blocked_profile_id = profile_b)
       or (b.blocker_profile_id = profile_b and b.blocked_profile_id = profile_a)
  );
$$;

revoke all on function public.pair_is_blocked(uuid, uuid) from public;
grant execute on function public.pair_is_blocked(uuid, uuid) to authenticated;

alter table public.blocks enable row level security;

-- INSERT: the blocker must resolve to the caller's own profile (never client
-- input), the caller must be VERIFIED, and the target must be a VERIFIED
-- profile. Self-blocks additionally fail the table CHECK.
create policy "blocks_insert_own"
  on public.blocks for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles blocker
      where blocker.id = blocker_profile_id
        and blocker.auth_user_id = (select auth.uid())
    )
    and public.is_current_user_verified()
    and public.is_profile_verified(blocked_profile_id)
  );

-- SELECT: only the blocker's own outgoing rows. The blocked user gets no
-- read path in either direction — a block must never leak to its target.
create policy "blocks_select_own_outgoing"
  on public.blocks for select to authenticated
  using (
    exists (
      select 1 from public.profiles blocker
      where blocker.id = blocker_profile_id
        and blocker.auth_user_id = (select auth.uid())
    )
  );

-- DELETE: unblocking is owner-only and reversible.
create policy "blocks_delete_own"
  on public.blocks for delete to authenticated
  using (
    exists (
      select 1 from public.profiles blocker
      where blocker.id = blocker_profile_id
        and blocker.auth_user_id = (select auth.uid())
    )
  );

-- No UPDATE policies: a block row never changes target or direction.
revoke all on public.blocks from anon, authenticated;
grant select, insert, delete on public.blocks to authenticated;
grant all on public.blocks to service_role;

-- ---------------------------------------------------------------------------
-- reports — reporter, target, reason category, optional detail/content ref.
-- ---------------------------------------------------------------------------
create table public.reports (
  id                  uuid primary key default gen_random_uuid(),
  reporter_profile_id uuid not null references public.profiles (id) on delete cascade,
  reported_profile_id uuid not null references public.profiles (id) on delete cascade,
  reason              text not null,
  detail              text,
  content_type        text,
  content_id          uuid,
  status              text not null default 'OPEN',
  created_at          timestamptz not null default now(),

  constraint reports_no_self_report check (reporter_profile_id <> reported_profile_id),
  constraint reports_reason_valid check (
    reason in (
      'harassment', 'inappropriate_content', 'fake_profile',
      'underage', 'spam', 'other'
    )
  ),
  constraint reports_detail_valid check (
    detail is null
    or (detail = btrim(detail) and char_length(detail) between 1 and 1000)
  ),
  -- The content reference is nullable as a pair: both set or both absent.
  constraint reports_content_pair_valid check (
    (content_type is null) = (content_id is null)
  ),
  constraint reports_content_type_valid check (
    content_type is null or content_type in ('profile', 'message', 'photo')
  ),
  constraint reports_status_valid check (status in ('OPEN', 'REVIEWED', 'DISMISSED'))
);

create index reports_reported_profile_id_idx on public.reports (reported_profile_id);
create index reports_status_created_idx on public.reports (status, created_at);

alter table public.reports enable row level security;

-- INSERT: the reporter must resolve to the caller's own profile (never
-- client input) and the caller must be VERIFIED. The target need only exist
-- (a report must never be structurally impossible); self-reports fail the
-- table CHECK. Duplicate reports are allowed — report volume per target is
-- admin signal, not an error.
create policy "reports_insert_own"
  on public.reports for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles reporter
      where reporter.id = reporter_profile_id
        and reporter.auth_user_id = (select auth.uid())
    )
    and public.is_current_user_verified()
  );

-- SELECT: staff only. Deliberately NO user policy — reporters cannot read
-- reports back (even their own), so the table can never become a leak or
-- probe channel and contents stay admin-only.
create policy "reports_select_staff"
  on public.reports for select to authenticated
  using (
    exists (
      select 1 from public.staff_admins s
      where s.auth_user_id = (select auth.uid())
    )
  );

-- No UPDATE/DELETE policies: reports are immutable for normal users; the
-- status transition workflow is a future staff slice (service role only).
revoke all on public.reports from anon, authenticated;
grant insert, select on public.reports to authenticated;
grant all on public.reports to service_role;

-- ---------------------------------------------------------------------------
-- Block integration — matches become invisible while a block stands.
-- The row is retained; removing the block restores access automatically.
-- ---------------------------------------------------------------------------
drop policy "matches_select_participant" on public.matches;
create policy "matches_select_participant"
  on public.matches for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.auth_user_id = (select auth.uid())
        and (p.id = user_a_id or p.id = user_b_id)
    )
    and not public.pair_is_blocked(user_a_id, user_b_id)
  );

-- Messages follow their match: participant of an ACTIVE match with no active
-- block in either direction. Rows are retained and access is restored when
-- the block is removed.
drop policy "messages_select_participant" on public.messages;
create policy "messages_select_participant"
  on public.messages for select to authenticated
  using (
    exists (
      select 1
      from public.matches m
      where m.id = match_id
        and m.unmatched_at is null
        and not public.pair_is_blocked(m.user_a_id, m.user_b_id)
        and exists (
          select 1 from public.profiles p
          where p.auth_user_id = (select auth.uid())
            and (p.id = m.user_a_id or p.id = m.user_b_id)
        )
    )
  );

-- Likes/passes cannot cross an active block (defense-in-depth behind the
-- backend's 404).
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
  );

-- ---------------------------------------------------------------------------
-- send_conversation_message — unchanged signature and grants; the WHERE
-- gains a block exclusion so a send across an active block raises the same
-- "not an active participant" error the backend already maps to 404.
-- ---------------------------------------------------------------------------
create or replace function public.send_conversation_message(
  p_match_id uuid,
  p_sender_profile_id uuid,
  p_body text
)
returns public.messages
language plpgsql
as $$
declare
  v_message public.messages;
  v_recipient uuid;
begin
  -- Participant + active-match + no-active-block check FIRST (the backend
  -- re-checks too; this is defense-in-depth against any future non-service
  -- caller).
  select case when user_a_id = p_sender_profile_id then user_b_id else user_a_id end
    into v_recipient
  from public.matches
  where id = p_match_id
    and unmatched_at is null
    and p_sender_profile_id in (user_a_id, user_b_id)
    and not public.pair_is_blocked(user_a_id, user_b_id);

  if v_recipient is null then
    raise exception 'sender is not an active participant of this match';
  end if;

  insert into public.messages (match_id, sender_profile_id, body)
  values (p_match_id, p_sender_profile_id, p_body)
  returning * into v_message;

  update public.matches
  set user_a_unread_count = user_a_unread_count + case when user_a_id = v_recipient then 1 else 0 end,
      user_b_unread_count = user_b_unread_count + case when user_b_id = v_recipient then 1 else 0 end
  where id = p_match_id;

  return v_message;
end;
$$;

revoke all on function public.send_conversation_message(uuid, uuid, text) from public;
grant execute on function public.send_conversation_message(uuid, uuid, text) to service_role;
