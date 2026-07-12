create or replace view public.employee_daily_trips
with (security_invoker = true)
as
with base as (
  select
    i.id,
    i.employee_id,
    i.client_id,
    i.date,
    coalesce(
      i.actual_start,
      (i.date::timestamp + i.start_time_planned::interval)::timestamptz
    ) as sort_ts
  from public.interventions i
  left join public.interventions_progress_admin ipa on ipa.id = i.id
  where i.duplicated_from_intervention_id is null
    and (
      i.status = 'done'
      or ipa.fait in ('fait', 'valid' || chr(233))
    )
),
sequenced as (
  select
    employee_id,
    date,
    id as from_intervention_id,
    client_id as from_client_id,
    lead(id) over (
      partition by employee_id, date
      order by sort_ts
    ) as to_intervention_id,
    lead(client_id) over (
      partition by employee_id, date
      order by sort_ts
    ) as to_client_id
  from base
)
select
  employee_id,
  date,
  from_intervention_id,
  from_client_id,
  to_intervention_id,
  to_client_id
from sequenced
where to_intervention_id is not null
  and from_client_id is not null
  and to_client_id is not null
  and from_client_id <> to_client_id;

create or replace view public.employee_month_summary
with (security_invoker = true)
as
with interv as (
  select
    i.employee_id,
    date_trunc('month', i.date)::date as month,
    sum(
      greatest(
        0,
        extract(epoch from (
          i.date::timestamp + i.end_time_planned::interval
          - (i.date::timestamp + i.start_time_planned::interval)
        )) / 3600.0
      )
    ) as hours_worked
  from public.interventions i
  left join public.interventions_progress_admin ipa on ipa.id = i.id
  where i.duplicated_from_intervention_id is null
    and (
      i.status = 'done'
      or ipa.fait in ('fait', 'valid' || chr(233))
    )
    and i.start_time_planned is not null
    and i.end_time_planned is not null
  group by i.employee_id, date_trunc('month', i.date)::date
),
trips as (
  select
    t.employee_id,
    date_trunc('month', t.date)::date as month,
    sum(coalesce(t.distance_km, 0)) filter (
      where t.distance_km is not null
    ) as km_travelled_km,
    count(*) filter (
      where t.distance_km is null
    ) as trips_with_missing_distance
  from public.employee_daily_trips_with_distance t
  group by t.employee_id, date_trunc('month', t.date)::date
)
select
  coalesce(i.employee_id, t.employee_id) as employee_id,
  e.first_name,
  e.last_name,
  coalesce(i.month, t.month) as month,
  coalesce(i.hours_worked, 0) as hours_worked,
  coalesce(t.km_travelled_km, 0) as km_travelled_km,
  coalesce(t.trips_with_missing_distance, 0) as trips_with_missing_distance
from interv i
full join trips t
  on t.employee_id = i.employee_id
 and t.month = i.month
left join public.employees e
  on e.id = coalesce(i.employee_id, t.employee_id);

drop view if exists public.client_month_summary;

create or replace view public.client_monthly_bilan
with (security_invoker = true)
as
select
  c.id as client_id,
  c.name as client_name,
  to_char(date_trunc('month', i.date), 'TMMonth') as month,
  extract(year from i.date)::integer as year,
  extract(month from i.date)::integer as month_number,
  round(sum(
    case
      when i.actual_duration_min is not null
        then i.actual_duration_min::numeric / 60.0
      else extract(epoch from (
        i.date::timestamp + i.end_time_planned::interval
        - (i.date::timestamp + i.start_time_planned::interval)
      )) / 3600.0
    end
  ), 2) as hours_worked
from public.interventions i
join public.clients c on c.id = i.client_id
left join public.interventions_progress_admin ipa on ipa.id = i.id
where i.duplicated_from_intervention_id is null
  and (
    i.status = 'done'
    or ipa.fait in ('fait', 'valid' || chr(233))
  )
group by
  c.id,
  c.name,
  date_trunc('month', i.date),
  extract(year from i.date),
  extract(month from i.date);

create or replace view public.client_month_summary
with (security_invoker = true)
as
select * from public.client_monthly_bilan;

grant select on public.employee_daily_trips to authenticated;
grant select on public.employee_month_summary to authenticated;
grant select on public.client_monthly_bilan to authenticated;
grant select on public.client_month_summary to authenticated;
revoke all on public.employee_daily_trips from anon;
revoke all on public.employee_month_summary from anon;
revoke all on public.client_monthly_bilan from anon;
revoke all on public.client_month_summary from anon;

notify pgrst, 'reload schema';
