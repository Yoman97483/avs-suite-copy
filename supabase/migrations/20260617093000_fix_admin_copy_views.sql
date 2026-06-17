grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

drop view if exists public.client_monthly_bilan;
drop view if exists public.client_month_summary;
drop view if exists public.employee_month_summary;
drop view if exists public.missing_client_distances;
drop view if exists public.interventions_progress_admin;

create or replace view public.interventions_progress_admin
with (security_invoker = true)
as
select
  i.id,
  i.client_id,
  i.employee_id,
  i.date,
  i.start_time_planned,
  i.end_time_planned,
  i.status,
  i.saved,
  i.actual_start,
  i.actual_end,
  i.actual_duration_min,
  c.name as client_name,
  concat_ws(' ', e.first_name, e.last_name) as employee_name,
  (i.saved = true or i.status = 'done') as fait
from public.interventions i
join public.clients c on c.id = i.client_id
join public.employees e on e.id = i.employee_id;

create or replace view public.missing_client_distances
with (security_invoker = true)
as
with ordered_interventions as (
  select
    i.employee_id,
    i.date,
    i.start_time_planned,
    i.client_id as from_client_id,
    lead(i.client_id) over (
      partition by i.employee_id, i.date
      order by i.start_time_planned, i.id
    ) as to_client_id
  from public.interventions i
  where i.client_id is not null
),
normalized_pairs as (
  select distinct
    least(from_client_id, to_client_id) as client_a_id,
    greatest(from_client_id, to_client_id) as client_b_id
  from ordered_interventions
  where to_client_id is not null
    and from_client_id <> to_client_id
)
select
  p.client_a_id,
  ca.name as client_a_name,
  p.client_b_id,
  cb.name as client_b_name
from normalized_pairs p
join public.clients ca on ca.id = p.client_a_id
join public.clients cb on cb.id = p.client_b_id
left join public.client_distances cd
  on cd.client_a_id = p.client_a_id
 and cd.client_b_id = p.client_b_id
where cd.id is null;

create or replace view public.employee_month_summary
with (security_invoker = true)
as
with intervention_hours as (
  select
    i.employee_id,
    date_trunc('month', i.date)::date as month,
    sum(coalesce(i.actual_duration_min, 0))::numeric / 60.0 as hours_worked
  from public.interventions i
  group by i.employee_id, date_trunc('month', i.date)::date
),
trip_candidates as (
  select
    i.employee_id,
    date_trunc('month', i.date)::date as month,
    least(i.client_id, lead(i.client_id) over (partition by i.employee_id, i.date order by i.start_time_planned, i.id)) as client_a_id,
    greatest(i.client_id, lead(i.client_id) over (partition by i.employee_id, i.date order by i.start_time_planned, i.id)) as client_b_id
  from public.interventions i
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

create or replace view public.client_monthly_bilan
with (security_invoker = true)
as
select
  c.id as client_id,
  c.name as client_name,
  to_char(date_trunc('month', i.date), 'TMMonth') as month,
  extract(year from i.date)::int as year,
  extract(month from i.date)::int as month_number,
  sum(coalesce(i.actual_duration_min, 0))::numeric / 60.0 as hours_worked
from public.interventions i
join public.clients c on c.id = i.client_id
group by c.id, c.name, date_trunc('month', i.date), extract(year from i.date), extract(month from i.date);

create or replace view public.client_month_summary
with (security_invoker = true)
as
select * from public.client_monthly_bilan;

grant select on public.interventions_progress_admin to authenticated;
grant select on public.missing_client_distances to authenticated;
grant select on public.employee_month_summary to authenticated;
grant select on public.client_monthly_bilan to authenticated;
grant select on public.client_month_summary to authenticated;
revoke all on public.interventions_progress_admin from anon;
revoke all on public.missing_client_distances from anon;
revoke all on public.employee_month_summary from anon;
revoke all on public.client_monthly_bilan from anon;
revoke all on public.client_month_summary from anon;

notify pgrst, 'reload schema';
