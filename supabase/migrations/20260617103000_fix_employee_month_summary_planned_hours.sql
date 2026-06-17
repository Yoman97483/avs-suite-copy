drop view if exists public.employee_month_summary;

create or replace view public.employee_month_summary
with (security_invoker = true)
as
with completed_interventions as (
  select
    ipa.id,
    ipa.employee_id,
    ipa.client_id,
    ipa.date,
    ipa.start_time_planned,
    ipa.end_time_planned,
    date_trunc('month', ipa.date)::date as month,
    greatest(
      0,
      extract(epoch from (ipa.end_time_planned - ipa.start_time_planned)) / 3600.0
    )::numeric as planned_hours
  from public.interventions_progress_admin ipa
  where ipa.fait <> 'en attente'
),
intervention_hours as (
  select
    ci.employee_id,
    ci.month,
    sum(ci.planned_hours) as hours_worked
  from completed_interventions ci
  group by ci.employee_id, ci.month
),
trip_candidates as (
  select
    ci.employee_id,
    ci.month,
    least(
      ci.client_id,
      lead(ci.client_id) over (
        partition by ci.employee_id, ci.date
        order by ci.start_time_planned, ci.id
      )
    ) as client_a_id,
    greatest(
      ci.client_id,
      lead(ci.client_id) over (
        partition by ci.employee_id, ci.date
        order by ci.start_time_planned, ci.id
      )
    ) as client_b_id
  from completed_interventions ci
),
trip_summary as (
  select
    t.employee_id,
    t.month,
    sum(coalesce(cd.distance_km, 0)) as km_travelled_km,
    count(*) filter (where cd.id is null) as trips_with_missing_distance
  from trip_candidates t
  left join public.client_distances cd
    on cd.client_a_id = t.client_a_id
   and cd.client_b_id = t.client_b_id
  where t.client_a_id is not null
    and t.client_b_id is not null
    and t.client_a_id <> t.client_b_id
  group by t.employee_id, t.month
)
select
  e.id as employee_id,
  e.first_name,
  e.last_name,
  h.month,
  coalesce(h.hours_worked, 0) as hours_worked,
  coalesce(ts.km_travelled_km, 0) as km_travelled_km,
  coalesce(ts.trips_with_missing_distance, 0) as trips_with_missing_distance
from intervention_hours h
join public.employees e on e.id = h.employee_id
left join trip_summary ts on ts.employee_id = h.employee_id and ts.month = h.month;

grant select on public.employee_month_summary to authenticated;
revoke all on public.employee_month_summary from anon;

notify pgrst, 'reload schema';
