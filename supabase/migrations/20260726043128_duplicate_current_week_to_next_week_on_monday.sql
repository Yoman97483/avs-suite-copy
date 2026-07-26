create or replace function private.duplicate_current_week_interventions(
  p_source_monday date default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_local_today date := (now() at time zone 'Indian/Reunion')::date;
  v_source_monday date;
  v_inserted integer := 0;
begin
  v_source_monday := coalesce(
    date_trunc('week', p_source_monday::timestamp)::date,
    v_local_today - (extract(isodow from v_local_today)::integer - 1)
  );

  insert into public.interventions (
    client_id,
    employee_id,
    date,
    start_time_planned,
    end_time_planned,
    notes,
    status,
    saved,
    duplicated_from_intervention_id
  )
  select
    source_row.client_id,
    source_row.employee_id,
    source_row.date + 7,
    source_row.start_time_planned,
    source_row.end_time_planned,
    source_row.notes,
    'planned',
    false,
    source_row.id
  from public.interventions source_row
  where source_row.date >= v_source_monday
    and source_row.date < v_source_monday + 7
    and not exists (
      select 1
      from public.intervention_duplication_skips skipped
      where skipped.source_intervention_id = source_row.id
        and skipped.employee_id = source_row.employee_id
        and skipped.target_date = source_row.date + 7
    )
    and not exists (
      select 1
      from public.interventions existing_copy
      where existing_copy.duplicated_from_intervention_id = source_row.id
        and existing_copy.employee_id = source_row.employee_id
        and existing_copy.date = source_row.date + 7
    )
    and not exists (
      select 1
      from public.interventions occupied_slot
      where occupied_slot.employee_id = source_row.employee_id
        and occupied_slot.date = source_row.date + 7
        and occupied_slot.start_time_planned = source_row.start_time_planned
        and occupied_slot.end_time_planned = source_row.end_time_planned
    )
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function private.duplicate_current_week_interventions(date)
  from public;

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname in (
      'avs_duplicate_previous_week_interventions',
      'avs_duplicate_current_week_interventions'
    )
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  -- pg_cron uses UTC: Sunday 20:05 UTC is Monday 00:05 in Reunion.
  perform cron.schedule(
    'avs_duplicate_current_week_interventions',
    '5 20 * * 0',
    'select private.duplicate_current_week_interventions();'
  );
end;
$$;

-- Catch up the current schedule because the former Monday job copied the
-- previous week into this week instead of this week into the next one.
select private.duplicate_current_week_interventions();
