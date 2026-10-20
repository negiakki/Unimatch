-- ============================================================================
-- UniMatch — simplify ephemeral conversations: delete at the 24h boundary
--
-- Product rule: a chat disappears after 24 hours without a message. When it
-- expires its messages are DELETED — there is no extra 24h/48h retention
-- window. The match stays active and either participant can start a fresh
-- chat (empty history) with a new message.
--
-- Changes (no existing migration is modified):
--   1. `messages.expired_at` marks report-pinned rows that were retained past
--      their conversation's expiry. Staff still read them through the service
--      role, but participants never see them again (RLS + backend filter) —
--      even after a later send resets `matches.last_message_at`.
--   2. `send_conversation_message` locks the match row while it restarts an
--      expired conversation. Deletion, marker, insert, window reset and
--      counter update are one transaction, so a successfully sent message can
--      never be removed by a concurrent cleanup/restart.
--   3. `expire_stale_conversations` deletes at the same 24h boundary (not
--      48h), locks each candidate match (`for update skip locked`) so it never
--      races a send, marks OPEN-report survivors expired, and zeroes counters.
--   4. pg_cron is enabled (when the project role may do so) and the cleanup job
--      is scheduled independently of any user opening the app. Failure to
--      create pg_cron or schedule the job ABORTS the migration: a chat policy
--      without background cleanup must never be recorded as successfully
--      applied.
--
-- Enforcement remains layered: RLS hides expired chats immediately; the send
-- RPC and scheduled cleanup physically delete them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Report-pinned survivors are kept for staff review only. `expired_at` is the
-- permanent "not part of any participant conversation" marker.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists expired_at timestamptz;

-- ---------------------------------------------------------------------------
-- Backfill legacy report-pinned survivors.
--
-- The previous policy cleaned up at 48h and kept OPEN-report messages forever.
-- When a later message restarted that conversation, the retained row had no
-- expiry marker and the 24h window (now fresh) made it visible to participants
-- again. A gap of more than 24h between CONSECUTIVE messages ends a round, so
-- every message in a round before the latest one belonged to an expired
-- conversation. Mark those rows permanently outside participant history. They
-- are retained (never deleted) for staff.
-- Idempotent: already-marked rows keep their original expiration time.
-- ---------------------------------------------------------------------------
with ordered as (
  select
    msg.id,
    msg.match_id,
    msg.created_at,
    lag(msg.created_at) over (
      partition by msg.match_id
      order by msg.created_at, msg.id
    ) as prev_created_at
  from public.messages msg
),
rounds as (
  select
    id,
    match_id,
    sum(
      case
        when prev_created_at is null
          or created_at > prev_created_at + interval '24 hours'
        then 1
        else 0
      end
    ) over (
      partition by match_id
      order by created_at, id
    ) as round_no
  from ordered
),
latest_round as (
  select match_id, max(round_no) as round_no
  from rounds
  group by match_id
)
update public.messages msg
set expired_at = coalesce(msg.expired_at, now())
from rounds r
join latest_round l on l.match_id = r.match_id
where msg.id = r.id
  and msg.expired_at is null
  and r.round_no < l.round_no;

-- ---------------------------------------------------------------------------
-- Participant reads additionally exclude retained (report-pinned) rows. The
-- 24h conversation window remains the primary gate.
-- ---------------------------------------------------------------------------
drop policy if exists "messages_select_participant" on public.messages;
create policy "messages_select_participant"
  on public.messages for select to authenticated
  using (
    expired_at is null
    and exists (
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
-- send_conversation_message — lock the match, clear an expired round, insert.
--
-- `for update` serializes this send with a restart/cleanup working on the same
-- match. Expired content is deleted first (except OPEN-report survivors, which
-- are marked `expired_at` so they cannot become visible again). The new
-- message uses `clock_timestamp()` — not the transaction-start `now()` — so a
-- send that waited on the lock still gets a current window.
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
  v_last_message_at timestamptz;
  v_now timestamptz;
begin
  -- Participant + active-match + no-active-block check FIRST, while taking the
  -- per-conversation lock that cleanup also uses.
  select
    case when user_a_id = p_sender_profile_id then user_b_id else user_a_id end,
    last_message_at
  into v_recipient, v_last_message_at
  from public.matches
  where id = p_match_id
    and unmatched_at is null
    and p_sender_profile_id in (user_a_id, user_b_id)
    and not public.pair_is_blocked(user_a_id, user_b_id)
  for update;

  if v_recipient is null then
    raise exception 'sender is not an active participant of this match';
  end if;

  v_now := clock_timestamp();

  if v_last_message_at is not null
     and v_last_message_at < v_now - interval '24 hours' then
    -- Fresh start: delete the expired round, keeping only OPEN-report
    -- survivors for staff, and mark those survivors permanently expired.
    delete from public.messages msg
    where msg.match_id = p_match_id
      and not exists (
        select 1 from public.reports r
        where r.content_type = 'message'
          and r.content_id = msg.id
          and r.status = 'OPEN'
      );

    update public.messages msg
    set expired_at = coalesce(msg.expired_at, v_now)
    where msg.match_id = p_match_id
      and msg.expired_at is null;

    -- The expired round's unread counters are stale.
    update public.matches
    set user_a_unread_count = 0,
        user_b_unread_count = 0
    where id = p_match_id;
  end if;

  insert into public.messages (match_id, sender_profile_id, body, created_at)
  values (p_match_id, p_sender_profile_id, p_body, v_now)
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
-- expire_stale_conversations — physical deletion at the 24h boundary.
--
-- `for update skip locked` makes cleanup and sends mutually exclusive per
-- match: a match being restarted is skipped (the send handles it), and a
-- match locked here cannot receive a send until cleanup commits. Returns the
-- number of expired matches cleaned (same contract as the previous version).
-- OPEN-report survivors stay for staff but are marked expired; unread counters
-- are reset because the chat is over.
-- ---------------------------------------------------------------------------
create or replace function public.expire_stale_conversations()
returns integer
language plpgsql
as $$
declare
  v_match_id uuid;
  v_cleaned integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  for v_match_id in
    select id
    from public.matches
    where last_message_at is not null
      and last_message_at < v_now - interval '24 hours'
    for update skip locked
  loop
    delete from public.messages msg
    where msg.match_id = v_match_id
      and not exists (
        select 1 from public.reports r
        where r.content_type = 'message'
          and r.content_id = msg.id
          and r.status = 'OPEN'
      );

    -- OPEN-report survivors remain readable by staff (service role) but are
    -- permanently outside participant history.
    update public.messages msg
    set expired_at = coalesce(msg.expired_at, v_now)
    where msg.match_id = v_match_id
      and msg.expired_at is null;

    update public.matches
    set user_a_unread_count = 0,
        user_b_unread_count = 0
    where id = v_match_id;

    v_cleaned := v_cleaned + 1;
  end loop;

  return v_cleaned;
end;
$$;

revoke all on function public.expire_stale_conversations() from public;
grant execute on function public.expire_stale_conversations() to service_role;

-- ---------------------------------------------------------------------------
-- Scheduling. Try to enable pg_cron when it is not installed (Supabase installs
-- it into pg_catalog), then schedule the cleanup job. This step is FAIL-CLOSED:
-- if the extension cannot be created, or the job cannot be unscheduled and
-- (re)scheduled, the migration raises and rolls back. Silently committing
-- without background deletion would allow expired conversations to survive
-- indefinitely.
--
-- Availability is detected from the cron objects the job actually needs, so a
-- test/local pg_cron emulation can exercise the same path without a hosted
-- instance. The job runs every 5 minutes, independently of app traffic.
-- ---------------------------------------------------------------------------
do $do$
declare
  v_job_exists boolean;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regclass('cron.job') is null then
    begin
      execute 'create extension if not exists pg_cron with schema pg_catalog';
    exception when others then
      raise exception
        'unimatch: 24h chat cleanup could not be scheduled; pg_cron is unavailable (%)',
        sqlerrm
        using hint = 'Enable pg_cron in the Supabase dashboard, then rerun this migration.';
    end;
  end if;

  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regclass('cron.job') is null then
    raise exception
      'unimatch: 24h chat cleanup could not be scheduled; pg_cron is not installed'
      using hint = 'Enable pg_cron in the Supabase dashboard, then rerun this migration.';
  end if;

  -- Ancillary grants are best-effort; they are not required for the job row.
  begin
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
  exception when others then
    raise warning 'pg_cron grants skipped: %', sqlerrm;
  end;

  begin
    execute
      'select exists (select 1 from cron.job where jobname = $1)'
      into v_job_exists
      using 'unimatch-expire-stale-conversations';

    if v_job_exists then
      execute 'select cron.unschedule($1)'
        using 'unimatch-expire-stale-conversations';
    end if;

    execute 'select cron.schedule($1, $2, $3)'
      using
        'unimatch-expire-stale-conversations',
        '*/5 * * * *',
        'select public.expire_stale_conversations();';
  exception when others then
    raise exception
      'unimatch: 24h chat cleanup could not be scheduled: %', sqlerrm
      using hint = 'Fix the pg_cron schedule permissions and rerun this migration.';
  end;
end
$do$;
