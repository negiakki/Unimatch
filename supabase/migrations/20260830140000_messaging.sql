-- ============================================================================
-- UniMatch — Phase 7 slice: messaging (conversations + text messages)
--
-- Adds:
--   * public.messages — immutable text messages. A conversation IS an active
--     match: `match_id` references public.matches with ON DELETE CASCADE, so
--     there is no separate conversations table. Every access (RLS policy and
--     backend) requires the underlying match to still be ACTIVE
--     (unmatched_at IS NULL), so a future unmatch makes the conversation
--     inaccessible immediately while the rows are retained.
--   * public.matches.user_a_unread_count / user_b_unread_count — simple
--     per-participant unread counters (decision: counters, not per-message
--     read receipts). Incremented atomically by the send RPC; zeroed by the
--     backend's service-role mark-read update.
--   * public.send_conversation_message(match_id, sender_profile_id, body) —
--     one atomic service-role RPC that inserts the message AND increments the
--     recipient's unread counter (no window where the message exists but the
--     counter missed it). Normal users have no direct write path to either
--     table; identity is always resolved server-side from the bearer token.
--
-- Messages are immutable in v1: no UPDATE/DELETE grants or policies.
-- Realtime is deferred; clients poll (~5s) while a conversation is open.
--
-- No existing migration is modified. Storage RLS is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Per-participant unread counters on matches (columns default to 0 for the
-- matches created before this slice — there is no backfill to run).
-- ---------------------------------------------------------------------------
alter table public.matches
  add column user_a_unread_count smallint not null default 0,
  add column user_b_unread_count smallint not null default 0;

alter table public.matches
  add constraint matches_unread_counts_non_negative check (
    user_a_unread_count >= 0 and user_b_unread_count >= 0
  );

-- ---------------------------------------------------------------------------
-- messages — immutable participant text messages, keyed by (active) match.
-- The body is stored trimmed; the backend trims before insert and rejects
-- empty-after-trim bodies (1..2000 characters) — the CHECK is the same rule
-- enforced at the database as defense-in-depth.
-- ---------------------------------------------------------------------------
create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null references public.matches (id) on delete cascade,
  sender_profile_id uuid not null references public.profiles (id) on delete cascade,
  body              text not null,
  created_at        timestamptz not null default now(),

  constraint messages_body_valid check (
    body = btrim(body) and char_length(body) between 1 and 2000
  )
);

-- Keyset pagination (created_at, id) within one conversation, plus the
-- newest-page poll; one composite index serves both directions.
create index messages_match_id_created_at_idx
  on public.messages (match_id, created_at, id);

alter table public.messages enable row level security;

-- SELECT: participants of an ACTIVE match only. Nonparticipants see nothing
-- (no existence leak). Once the match is unmatched (future unmatch phase),
-- the conversation is inaccessible immediately — for reads too. There are
-- deliberately no INSERT/UPDATE/DELETE policies: the backend's service-role
-- client is the only writer, and identity comes from the bearer token.
create policy "messages_select_participant"
  on public.messages for select to authenticated
  using (
    exists (
      select 1
      from public.matches m
      where m.id = match_id
        and m.unmatched_at is null
        and exists (
          select 1 from public.profiles p
          where p.auth_user_id = (select auth.uid())
            and (p.id = m.user_a_id or p.id = m.user_b_id)
        )
    )
  );

revoke all on public.messages from anon;
revoke update, delete on public.messages from authenticated;
grant select on public.messages to authenticated;
grant all on public.messages to service_role;

-- ---------------------------------------------------------------------------
-- send_conversation_message — the backend's single atomic send operation.
--
-- Inserts the message and increments the RECIPIENT's unread counter in one
-- statement pair inside one call. The service role resolves both profile ids
-- from the bearer token (never client input) before calling this; the caller
-- MUST be a participant of the match and the match MUST be active — both are
-- re-checked here as defense-in-depth (empty update/insert otherwise).
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
  -- Participant + active-match check FIRST (the backend re-checks too; this
  -- is defense-in-depth against any future non-service caller).
  select case when user_a_id = p_sender_profile_id then user_b_id else user_a_id end
    into v_recipient
  from public.matches
  where id = p_match_id
    and unmatched_at is null
    and p_sender_profile_id in (user_a_id, user_b_id);

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
