alter table public.interventions
  add constraint interventions_duplicated_from_intervention_id_fkey
  foreign key (duplicated_from_intervention_id)
  references public.interventions(id)
  on delete cascade;

comment on column public.interventions.duplicated_from_intervention_id is
  'Source intervention copied by weekly duplication. Deleting the source also deletes its duplicate.';

create or replace function private.duplicate_new_current_week_intervention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local_today date := (now() at time zone 'Indian/Reunion')::date;
  v_current_monday date;
  v_target_date date;
begin
  if new.duplicated_from_intervention_id is not null then
    return new;
  end if;

  v_current_monday := v_local_today
    - (extract(isodow from v_local_today)::integer - 1);

  if new.date < v_current_monday or new.date >= v_current_monday + 7 then
    return new;
  end if;

  v_target_date := new.date + 7;

  if exists (
    select 1
    from public.intervention_duplication_skips skipped
    where skipped.source_intervention_id = new.id
      and skipped.employee_id = new.employee_id
      and skipped.target_date = v_target_date
  ) then
    return new;
  end if;

  if exists (
    select 1
    from public.interventions existing_copy
    where existing_copy.duplicated_from_intervention_id = new.id
      and existing_copy.employee_id = new.employee_id
      and existing_copy.date = v_target_date
  ) then
    return new;
  end if;

  if exists (
    select 1
    from public.interventions occupied_slot
    where occupied_slot.employee_id = new.employee_id
      and occupied_slot.date = v_target_date
      and occupied_slot.start_time_planned = new.start_time_planned
      and occupied_slot.end_time_planned = new.end_time_planned
  ) then
    return new;
  end if;

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
  values (
    new.client_id,
    new.employee_id,
    v_target_date,
    new.start_time_planned,
    new.end_time_planned,
    new.notes,
    'planned',
    false,
    new.id
  )
  on conflict do nothing;

  return new;
end;
$$;

revoke all on function private.duplicate_new_current_week_intervention()
  from public;

drop trigger if exists interventions_duplicate_new_current_week
  on public.interventions;

create trigger interventions_duplicate_new_current_week
after insert on public.interventions
for each row execute function private.duplicate_new_current_week_intervention();

-- Catch up any intervention created earlier in the current week before the
-- trigger existed, including the intervention reported on 16 July.
with bounds as (
  select
    (now() at time zone 'Indian/Reunion')::date
      - (extract(isodow from (now() at time zone 'Indian/Reunion')::date)::integer - 1)
      as current_monday
)
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
cross join bounds b
where source_row.date >= b.current_monday
  and source_row.date < b.current_monday + 7
  and source_row.duplicated_from_intervention_id is null
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
