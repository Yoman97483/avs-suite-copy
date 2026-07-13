-- Remove only the untouched copies that the former browser-side mechanism
-- created one week too early. The one already edited by the administrator is
-- deliberately preserved.
delete from public.interventions duplicate_row
using public.interventions source_row
where duplicate_row.duplicated_from_intervention_id = source_row.id
  and duplicate_row.date >= date '2026-07-20'
  and duplicate_row.date < date '2026-07-27'
  and (duplicate_row.created_at at time zone 'Indian/Reunion')::date = date '2026-07-13'
  and duplicate_row.client_id = source_row.client_id
  and duplicate_row.employee_id = source_row.employee_id
  and duplicate_row.date = source_row.date + 7
  and duplicate_row.start_time_planned = source_row.start_time_planned
  and duplicate_row.end_time_planned = source_row.end_time_planned
  and duplicate_row.status = 'planned'
  and coalesce(duplicate_row.saved, false) = false
  and not exists (
    select 1
    from public.pointages p
    where p.intervention_id = duplicate_row.id
  );

create or replace function private.duplicate_previous_week_interventions(
  p_target_monday date default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_local_today date := (now() at time zone 'Indian/Reunion')::date;
  v_target_monday date;
  v_source_monday date;
  v_inserted integer := 0;
begin
  v_target_monday := coalesce(
    date_trunc('week', p_target_monday::timestamp)::date,
    v_local_today - (extract(isodow from v_local_today)::integer - 1)
  );
  v_source_monday := v_target_monday - 7;

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
    and source_row.date < v_target_monday
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

revoke all on function private.duplicate_previous_week_interventions(date) from public;

create or replace function private.enforce_duplicate_admin_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.duplicated_from_intervention_id is not null
     and current_user not in ('postgres', 'service_role', 'supabase_admin')
     and not coalesce(private.is_admin(), false) then
    raise exception 'Seul un administrateur peut modifier, valider ou supprimer une intervention dupliquee.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_duplicate_admin_mutation() from public;

drop trigger if exists interventions_duplicate_admin_mutation
  on public.interventions;

create trigger interventions_duplicate_admin_mutation
before update or delete on public.interventions
for each row execute function private.enforce_duplicate_admin_mutation();

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname = 'avs_duplicate_previous_week_interventions'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  -- pg_cron uses UTC: Sunday 20:05 UTC is Monday 00:05 in Reunion.
  perform cron.schedule(
    'avs_duplicate_previous_week_interventions',
    '5 20 * * 0',
    'select private.duplicate_previous_week_interventions();'
  );
end;
$$;
