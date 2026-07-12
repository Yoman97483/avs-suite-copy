create or replace view public.interventions_progress_admin
with (security_invoker = true)
as
with base as (
  select
    i.id,
    i.date,
    i.employee_id,
    i.client_id,
    i.start_time_planned,
    i.end_time_planned,
    (extract(epoch from (i.end_time_planned - i.start_time_planned)) / 60)::integer as planned_min,
    i.actual_start,
    i.actual_end,
    i.actual_duration_min,
    i.saved,
    i.status,
    i.completed_at,
    i.duplicated_from_intervention_id
  from public.interventions i
),
lasts as (
  select
    b.id as intervention_id,
    (select min(p.timestamp) from public.pointages p where p.intervention_id = b.id and p.type = 'start') as last_start,
    (select p.latitude from public.pointages p where p.intervention_id = b.id and p.type = 'start' order by p.timestamp limit 1) as last_start_latitude,
    (select p.longitude from public.pointages p where p.intervention_id = b.id and p.type = 'start' order by p.timestamp limit 1) as last_start_longitude,
    (select max(p.timestamp) from public.pointages p where p.intervention_id = b.id and p.type = 'end') as last_end,
    (select p.latitude from public.pointages p where p.intervention_id = b.id and p.type = 'end' order by p.timestamp desc limit 1) as last_end_latitude,
    (select p.longitude from public.pointages p where p.intervention_id = b.id and p.type = 'end' order by p.timestamp desc limit 1) as last_end_longitude
  from base b
),
computed as (
  select
    b.*,
    l.last_start,
    l.last_end,
    l.last_start_latitude,
    l.last_start_longitude,
    l.last_end_latitude,
    l.last_end_longitude,
    c.name as client_name,
    e.first_name,
    e.last_name,
    c.latitude as client_latitude,
    c.longitude as client_longitude,
    coalesce(b.actual_start, l.last_start) as actual_start_calc,
    coalesce(b.actual_end, l.last_end) as actual_end_calc,
    public.distance_meters(c.latitude, c.longitude, l.last_start_latitude, l.last_start_longitude) as distance_start_m,
    public.distance_meters(c.latitude, c.longitude, l.last_end_latitude, l.last_end_longitude) as distance_end_m
  from base b
  left join lasts l on l.intervention_id = b.id
  left join public.clients c on c.id = b.client_id
  left join public.employees e on e.id = b.employee_id
),
with_flags as (
  select
    c.*,
    case
      when c.actual_start_calc is not null and c.actual_end_calc is not null
        then greatest(0, (extract(epoch from (c.actual_end_calc - c.actual_start_calc)) / 60)::integer)
      else c.actual_duration_min
    end as actual_min_calc,
    case
      when c.actual_start_calc is null or c.actual_end_calc is null then false
      else greatest(
        0,
        (extract(epoch from (c.actual_end_calc - c.actual_start_calc)) / 60)::integer
      ) <= (c.planned_min - 5)
    end as pb_time,
    case
      when public.distance_meters(c.client_latitude, c.client_longitude, c.last_start_latitude, c.last_start_longitude) is null then false
      else public.distance_meters(c.client_latitude, c.client_longitude, c.last_start_latitude, c.last_start_longitude) >= 500
    end as pb_position_start,
    case
      when public.distance_meters(c.client_latitude, c.client_longitude, c.last_end_latitude, c.last_end_longitude) is null then false
      else public.distance_meters(c.client_latitude, c.client_longitude, c.last_end_latitude, c.last_end_longitude) >= 500
    end as pb_position_end
  from computed c
)
select
  w.id,
  w.date,
  w.employee_id,
  w.client_id,
  w.client_name,
  concat_ws(' ', w.first_name, w.last_name) as employee_name,
  w.start_time_planned,
  w.end_time_planned,
  w.planned_min,
  w.actual_start_calc as actual_start,
  w.actual_end_calc as actual_end,
  w.actual_min_calc as actual_min,
  w.client_latitude,
  w.client_longitude,
  w.last_start_latitude as actual_start_latitude,
  w.last_start_longitude as actual_start_longitude,
  w.last_end_latitude as actual_end_latitude,
  w.last_end_longitude as actual_end_longitude,
  w.distance_start_m,
  w.distance_end_m,
  w.pb_time,
  w.pb_position_start,
  w.pb_position_end,
  case
    when w.saved = true then 'validé'
    when w.actual_start_calc is null and w.actual_end_calc is null then 'en attente'
    when w.actual_start_calc is not null and w.actual_end_calc is null then 'en attente'
    when w.pb_time = true and (w.pb_position_start = true or w.pb_position_end = true) then 'Pb temps+position'
    when w.pb_position_start = true or w.pb_position_end = true then 'Pb position'
    when w.pb_time = true then 'Pb temps'
    else 'fait'
  end as fait,
  w.saved,
  w.status,
  w.completed_at,
  w.duplicated_from_intervention_id
from with_flags w;

grant select on public.interventions_progress_admin to authenticated;
revoke all on public.interventions_progress_admin from anon;

notify pgrst, 'reload schema';
