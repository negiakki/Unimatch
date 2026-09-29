-- ============================================================================
-- UniMatch — Ephemeral conversations: 24h inactivity expiry
--
-- Design (approved):
--   * A conversation (an ACTIVE match) expires after 24 hours of inactivity,
--     where inactivity is measured from the LAST message — never from match
--     creation. `matches.last_message_at` is NULL for a conversation with
--     no messages yet (nothing has been exchanged, nothing to expire).
--   * Messages are readable only while `last_message_at >= now() - 24h`.
--   * A new message resets the 24h window. If the conversation had already
--     expired, its old messages are deleted first, so expired content can
--     NEVER reappear (no soft-delete, no resurrect path).
--   * The match itself is untouched: expiry never unmatches or hides the
--     match — only the messages lapse. Blocked/unmatched conversations keep
--     their existing inaccessibility semantics unchanged.
--   * Report retention: messages referenced by an OPEN report are never
--     deleted by cleanup; they also stay invisible to ordinary users
--     (their RLS path is participant + not-expired, so expired rows remain
--     hidden from them even before cleanup deletes the rest). Staff access
--     runs through the service role (reports are admin-only).
--
-- Enforcement layers (DB remains authoritative even if cleanup runs late):
--   1. RLS on messages: participant of an ACTIVE, unblocked match whose
--      conversation is not expired.
--   2. The send RPC: deletes expired messages + resets the window + inserts
--      the new message + ticks the recipient unread counter atomically.
--   3. Cleanup (pg_cron service-role job): removes messages of conversations
--      expired for >24h (48h total) and zeroes unread counters, honoring
--      OPEN reports.
--
-- No existing migration is modified. Match semantics are untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- last_message_at on matches + backfill:
--   * conversations with existing messages → latest message timestamp
--   * conversations with no messages → NULL (never active → nothing expires)
-- ---------------------------------------------------------------------------
alter table public.matches
  add column last_message_at timestamptz;

update public.matches m
set last_message_at = msg.latest
from (
  select match_id, max(created_at) as latest
  from public.messages
  group by match_id
) msg
where msg.match_id = m.id;

-- Expiration/cleanup index: find conversations whose last activity is older
-- than the cutoff (the cron cleanup scans this way; RLS checks are per-match
-- and served by the primary key).
create index matches_last_message_at_idx
  on public.matches (last_message_at)
  where last_message_at is not null;

-- ---------------------------------------------------------------------------
-- RLS: messages become readable only while the conversation is active.
-- Replaces messages_select_participant (same participant + active-match +
-- no-block conditions, plus the not-expired gate). Expired messages are
-- invisible to participants immediately — identical non-existence behavior
-- to unauthorized conversations.
-- ---------------------------------------------------------------------------
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
        and (m.last_message_at is null or m.last_message_at >= now() - interval '24 hours')
        and exists (
          select 1 from public.profiles p
          where p.auth_user_id = (select auth.uid())
            and (p.id = m.user_a_id or p.id = m.user_b_id)
        )
    )
  );

-- ---------------------------------------------------------------------------
-- send_conversation_message — same signature and grants. Gains the expiry
-- reset: when the conversation has expired, its old messages are deleted
-- FIRST (unless held by an OPEN report), stale unread counters are zeroed,
-- then the new message is inserted, the window resets to it and the
-- recipient's unread counter ticks — all in this one atomic call (one
-- transaction). Old content can never reappear.
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
  v_was_expired boolean;
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

  -- Expiry check AFTER the participant gate (an outsider learns nothing
  -- either way): an expired conversation starts fresh — old messages are
  -- deleted here, so they can never reappear in the API or the UI.
  select last_message_at is not null and last_message_at < now() - interval '24 hours'
    into v_was_expired
  from public.matches
  where id = p_match_id;

  if v_was_expired then
    delete from public.messages
    where match_id = p_match_id
      and not exists (
        select 1 from public.reports r
        where r.content_type = 'message'
          and r.content_id = messages.id
          and r.status = 'OPEN'
      );
    -- Fresh conversation: the expired counters are stale; reset both.
    update public.matches
    set user_a_unread_count = 0,
        user_b_unread_count = 0
    where id = p_match_id;
  end if;

  insert into public.messages (match_id, sender_profile_id, body)
  values (p_match_id, p_sender_profile_id, p_body)
  returning * into v_message;

  -- Reset/extend the 24h window to the new message and tick ONLY the
  -- recipient's unread counter, atomically with the insert above.
  update public.matches
  set last_message_at = v_message.created_at,
      user_a_unread_count = user_a_unread_count + case when user_a_id = v_recipient then 1 else 0 end,
      user_b_unread_count = user_b_unread_count + case when user_b_id = v_recipient then 1 else 0 end
  where id = p_match_id;

  return v_message;
end;
$$;

revoke all on function public.send_conversation_message(uuid, uuid, text) from public;
grant execute on function public.send_conversation_message(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- expire_stale_conversations — the cleanup body, callable directly for tests
-- and manual runs. Deletes messages of conversations expired for >24h (a
-- full extra window past the visibility cutoff, so cleanup is always
-- strictly later than enforcement — the DB/RLS rule stays authoritative in
-- between), zeroes both unread counters, and NEVER touches messages
-- referenced by an OPEN report. Returns the number of matches cleaned.
-- Statements inside the function share one transaction: atomic.
-- ---------------------------------------------------------------------------
create or replace function public.expire_stale_conversations()
returns integer
language plpgsql
as $$
declare
  v_deleted integer;
begin
  delete from public.messages msg
  where msg.match_id in (
        select m.id
        from public.matches m
        where m.last_message_at is not null
          and m.last_message_at < now() - interval '48 hours'
      )
      and not exists (
        select 1 from public.reports r
        where r.content_type = 'message'
          and r.content_id = msg.id
          and r.status = 'OPEN'
      );
  get diagnostics v_deleted = row_count;

  update public.matches m
  set user_a_unread_count = 0,
      user_b_unread_count = 0
  where m.last_message_at is not null
    and m.last_message_at < now() - interval '48 hours'
    -- Only zero when every deletable message is actually gone: if an OPEN
    -- report still pins a message, its rows survive for staff review —
    -- leave the counters as they are.
    and not exists (
      select 1 from public.messages msg
      where msg.match_id = m.id
        and exists (
          select 1 from public.reports r
          where r.content_type = 'message'
            and r.content_id = msg.id
            and r.status = 'OPEN'
        )
    );

  return v_deleted;
end;
$$;

revoke all on function public.expire_stale_conversations() from public;
grant execute on function public.expire_stale_conversations() to service_role;

-- ---------------------------------------------------------------------------
-- pg_cron scheduling (Supabase-hosted Postgres cron).
--
-- MANUAL STEP REQUIRED on hosted Supabase: the `pg_cron` extension must be
-- enabled once (Dashboard → Database → Extensions, or SQL editor:
-- `create extension pg_cron;`). The schedule call below is idempotent
-- (unschedule → schedule) so re-running the migration is safe. If pg_cron
-- is not enabled, nothing here fails — the DB/RLS enforcement above remains
-- authoritative on its own; cleanup only reclaims rows (and resets
-- counters) once the job (or a manual `select public.expire_stale_conversations();`)
-- runs.
-- ---------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute (
      select case when exists (
        select 1 from cron.job where jobname = 'unimatch-expire-stale-conversations'
      ) then 'select cron.unschedule(''unimatch-expire-stale-conversations'')' end
    );
    perform cron.schedule(
      'unimatch-expire-stale-conversations',
      '17 * * * *', -- hourly at :17
      $$select public.expire_stale_conversations();$$
    );
  end if;
end
$do$;
