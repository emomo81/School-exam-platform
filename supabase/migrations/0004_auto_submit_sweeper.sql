-- =============================================================================
-- 0004 — server-side timer cutoff sweeper (PRD §4.1)
--
-- Backstop for the per-request cutoff enforced in the API: catches attempts
-- whose student dropped connection so they never triggered an auto-submit.
-- Runs every minute; the authoritative gate remains the per-write end_at check.
-- =============================================================================

create or replace function auto_submit_expired_attempts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  swept integer;
begin
  with expired as (
    update public.attempts a
       set status = 'auto_submitted_timer', submitted_at = now()
      from public.exams e
     where a.exam_id = e.id
       and a.status = 'in_progress'
       and e.end_at < now()
    returning a.exam_id, a.roll_number
  ),
  freed as (
    delete from public.active_sessions s
     using expired x
     where s.exam_id = x.exam_id and s.roll_number = x.roll_number
    returning 1
  )
  select count(*) into swept from expired;
  return swept;
end;
$$;

-- Schedule (by name → upserts if it already exists). pg_cron min granularity: 1 min.
select cron.schedule(
  'auto-submit-expired-attempts',
  '* * * * *',
  $$select public.auto_submit_expired_attempts()$$
);
