create table public.client_coordinate_history (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  latitude double precision not null,
  longitude double precision not null,
  valid_from date not null,
  valid_until date,
  provider text not null default 'manual',
  created_at timestamptz not null default now(),
  constraint client_coordinate_history_dates_check
    check (valid_until is null or valid_until >= valid_from),
  constraint client_coordinate_history_latitude_check
    check (latitude between -90 and 90),
  constraint client_coordinate_history_longitude_check
    check (longitude between -180 and 180),
  constraint client_coordinate_history_unique_start unique (client_id, valid_from)
);

create index client_coordinate_history_lookup_idx
  on public.client_coordinate_history (client_id, valid_from, valid_until);

alter table public.client_coordinate_history enable row level security;

create policy client_coordinate_history_select
on public.client_coordinate_history
for select to authenticated
using (
  (select private.is_admin())
  or exists (
    select 1
    from public.interventions i
    where i.client_id = client_coordinate_history.client_id
      and i.employee_id = (select auth.uid())
  )
);

grant select on public.client_coordinate_history to authenticated;

create table public.client_distance_history (
  id uuid primary key default gen_random_uuid(),
  client_a_id uuid not null references public.clients(id) on delete cascade,
  client_b_id uuid not null references public.clients(id) on delete cascade,
  distance_km numeric not null,
  valid_from date not null,
  valid_until date,
  created_at timestamptz not null default now(),
  constraint client_distance_history_pair_check check (client_a_id < client_b_id),
  constraint client_distance_history_distance_check check (distance_km >= 0),
  constraint client_distance_history_dates_check
    check (valid_until is null or valid_until >= valid_from),
  constraint client_distance_history_unique_start unique (client_a_id, client_b_id, valid_from)
);

create index client_distance_history_lookup_idx
  on public.client_distance_history (client_a_id, client_b_id, valid_from, valid_until);

alter table public.client_distance_history enable row level security;

create policy client_distance_history_select
on public.client_distance_history
for select to authenticated
using (true);

grant select on public.client_distance_history to authenticated;

-- Preserve the coordinates that produced all intervention results before 13 July.
insert into public.client_coordinate_history
  (client_id, latitude, longitude, valid_from, valid_until, provider)
select
  c.id,
  case c.id
    when '9f46ad57-6f98-4f41-875f-676b18cd633d'::uuid then -21.32569
    when '1fe001bf-c222-44ca-8d7f-3557dce13e18'::uuid then -21.28309
    when '3ea395c0-8e4d-42dd-a572-6befa3a1156e'::uuid then -21.2969843
    else c.latitude
  end,
  case c.id
    when '9f46ad57-6f98-4f41-875f-676b18cd633d'::uuid then 55.4837
    when '1fe001bf-c222-44ca-8d7f-3557dce13e18'::uuid then 55.51802
    when '3ea395c0-8e4d-42dd-a572-6befa3a1156e'::uuid then 55.4951647
    else c.longitude
  end,
  date '1900-01-01',
  date '2026-07-12',
  'legacy'
from public.clients c
where c.latitude is not null and c.longitude is not null;

with google_coordinates(client_id, latitude, longitude) as (
  values
    ('9f46ad57-6f98-4f41-875f-676b18cd633d'::uuid, -21.325638, 55.483764),
    ('02f276bf-ca24-4de0-ae85-32bee2f84d3a'::uuid, -21.2483689, 55.5217161),
    ('72e15b03-56a6-4ba8-bb41-eb53f15591da'::uuid, -21.2623138, 55.5015097),
    ('b1e5dd23-60e2-4d9a-a337-157b1b1a960e'::uuid, -21.3492174, 55.4856073),
    ('26cfa617-0589-4f7f-b357-ad51499e25f0'::uuid, -21.234274, 55.567365),
    ('43f94687-2802-43ef-b933-488b33bbfa0a'::uuid, -21.270288, 55.511941),
    ('4cbdf7a8-c0a7-4f45-8e42-0dcd8809e10d'::uuid, -21.3477344, 55.4823795),
    ('675f3fc9-cb14-4af8-8753-081bb87455a8'::uuid, -21.3215739, 55.535733),
    ('baf53080-f524-450b-aa64-d67318da7602'::uuid, -21.2875144, 55.523479),
    ('047e4f51-778a-440a-8026-fff68af8123e'::uuid, -21.2594279, 55.5253845),
    ('24f28e30-414b-4e4d-8350-a9a64aedcfe3'::uuid, -21.2625411, 55.5256522),
    ('7a4d1c02-3950-49c6-bdf9-719981df60bd'::uuid, -21.261235, 55.4308873),
    ('ef13c891-ca5d-4545-965f-ae0b14d4b30f'::uuid, -21.3354993, 55.4669426),
    ('6db0aa47-7bac-4552-9e05-f6bd3cca1071'::uuid, -21.2800011, 55.5007459),
    ('1ca4b1e1-75bc-40d8-8f7a-9fa0e4d112be'::uuid, -21.2730989, 55.443658),
    ('898fc702-73c3-4951-80dc-705707f1ed5d'::uuid, -21.2827957, 55.4300885),
    ('882e8971-ecf8-43c3-b2b8-31f6aad9317a'::uuid, -21.2757223, 55.4215019),
    ('1fe001bf-c222-44ca-8d7f-3557dce13e18'::uuid, -21.2679446, 55.5003392),
    ('3ea395c0-8e4d-42dd-a572-6befa3a1156e'::uuid, -21.296817, 55.495065),
    ('fe4a80fd-d6fe-4a73-8491-059141a452f7'::uuid, -21.3004598, 55.4946664),
    ('9a016d75-7b61-4f38-a198-579391e82380'::uuid, -21.2809507, 55.4417177),
    ('3465c6ab-7c42-4298-8c2e-9363dde4e8a4'::uuid, -21.337218, 55.473987),
    ('bb319b2a-5437-441d-a35a-06e73a03c3ec'::uuid, -21.2387301, 55.5398148),
    ('a14f75bd-72b5-4099-a979-03c29e2b8027'::uuid, -21.274299, 55.447326),
    ('2d043aaf-6b2c-489a-b6b0-801b0a7bdc68'::uuid, -21.3399908, 55.4690645),
    ('54136290-d714-4d07-8b44-483075f1db30'::uuid, -21.2834113, 55.5162196)
)
insert into public.client_coordinate_history
  (client_id, latitude, longitude, valid_from, provider)
select client_id, latitude, longitude, date '2026-07-13', 'google'
from google_coordinates;

with google_coordinates(client_id, latitude, longitude) as (
  values
    ('9f46ad57-6f98-4f41-875f-676b18cd633d'::uuid, -21.325638, 55.483764),
    ('02f276bf-ca24-4de0-ae85-32bee2f84d3a'::uuid, -21.2483689, 55.5217161),
    ('72e15b03-56a6-4ba8-bb41-eb53f15591da'::uuid, -21.2623138, 55.5015097),
    ('b1e5dd23-60e2-4d9a-a337-157b1b1a960e'::uuid, -21.3492174, 55.4856073),
    ('26cfa617-0589-4f7f-b357-ad51499e25f0'::uuid, -21.234274, 55.567365),
    ('43f94687-2802-43ef-b933-488b33bbfa0a'::uuid, -21.270288, 55.511941),
    ('4cbdf7a8-c0a7-4f45-8e42-0dcd8809e10d'::uuid, -21.3477344, 55.4823795),
    ('675f3fc9-cb14-4af8-8753-081bb87455a8'::uuid, -21.3215739, 55.535733),
    ('baf53080-f524-450b-aa64-d67318da7602'::uuid, -21.2875144, 55.523479),
    ('047e4f51-778a-440a-8026-fff68af8123e'::uuid, -21.2594279, 55.5253845),
    ('24f28e30-414b-4e4d-8350-a9a64aedcfe3'::uuid, -21.2625411, 55.5256522),
    ('7a4d1c02-3950-49c6-bdf9-719981df60bd'::uuid, -21.261235, 55.4308873),
    ('ef13c891-ca5d-4545-965f-ae0b14d4b30f'::uuid, -21.3354993, 55.4669426),
    ('6db0aa47-7bac-4552-9e05-f6bd3cca1071'::uuid, -21.2800011, 55.5007459),
    ('1ca4b1e1-75bc-40d8-8f7a-9fa0e4d112be'::uuid, -21.2730989, 55.443658),
    ('898fc702-73c3-4951-80dc-705707f1ed5d'::uuid, -21.2827957, 55.4300885),
    ('882e8971-ecf8-43c3-b2b8-31f6aad9317a'::uuid, -21.2757223, 55.4215019),
    ('1fe001bf-c222-44ca-8d7f-3557dce13e18'::uuid, -21.2679446, 55.5003392),
    ('3ea395c0-8e4d-42dd-a572-6befa3a1156e'::uuid, -21.296817, 55.495065),
    ('fe4a80fd-d6fe-4a73-8491-059141a452f7'::uuid, -21.3004598, 55.4946664),
    ('9a016d75-7b61-4f38-a198-579391e82380'::uuid, -21.2809507, 55.4417177),
    ('3465c6ab-7c42-4298-8c2e-9363dde4e8a4'::uuid, -21.337218, 55.473987),
    ('bb319b2a-5437-441d-a35a-06e73a03c3ec'::uuid, -21.2387301, 55.5398148),
    ('a14f75bd-72b5-4099-a979-03c29e2b8027'::uuid, -21.274299, 55.447326),
    ('2d043aaf-6b2c-489a-b6b0-801b0a7bdc68'::uuid, -21.3399908, 55.4690645),
    ('54136290-d714-4d07-8b44-483075f1db30'::uuid, -21.2834113, 55.5162196)
)
update public.clients c
set latitude = g.latitude,
    longitude = g.longitude,
    geocoded_at = now(),
    geocode_status = 'ok'
from google_coordinates g
where c.id = g.client_id;

-- Keep route values versioned too, so later Google recalculations cannot rewrite old reports.
insert into public.client_distance_history
  (client_a_id, client_b_id, distance_km, valid_from, valid_until)
select
  d.client_a_id,
  d.client_b_id,
  case
    when d.id = '2c33a4ba-2246-4d99-a7c5-cebfcdd79f43'::uuid then 7.48
    else d.distance_km
  end,
  date '1900-01-01',
  date '2026-07-12'
from public.client_distances d;

insert into public.client_distance_history
  (client_a_id, client_b_id, distance_km, valid_from)
select d.client_a_id, d.client_b_id, d.distance_km, date '2026-07-13'
from public.client_distances d;

create or replace function private.capture_client_coordinate_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_date date := (now() at time zone 'Indian/Reunion')::date;
begin
  if new.latitude is null or new.longitude is null then
    return new;
  end if;

  if old.latitude is not distinct from new.latitude
     and old.longitude is not distinct from new.longitude then
    return new;
  end if;

  update public.client_coordinate_history
  set valid_until = effective_date - 1
  where client_id = new.id
    and valid_until is null
    and valid_from < effective_date;

  insert into public.client_coordinate_history
    (client_id, latitude, longitude, valid_from, provider)
  values (new.id, new.latitude, new.longitude, effective_date, 'updated')
  on conflict (client_id, valid_from) do update
  set latitude = excluded.latitude,
      longitude = excluded.longitude,
      provider = excluded.provider,
      valid_until = null;

  return new;
end;
$$;

revoke all on function private.capture_client_coordinate_history() from public;

create trigger clients_capture_coordinate_history
after update of latitude, longitude on public.clients
for each row execute function private.capture_client_coordinate_history();

create or replace function private.capture_client_distance_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_date date := (now() at time zone 'Indian/Reunion')::date;
begin
  if tg_op = 'UPDATE' and old.distance_km is not distinct from new.distance_km then
    return new;
  end if;

  update public.client_distance_history
  set valid_until = effective_date - 1
  where client_a_id = new.client_a_id
    and client_b_id = new.client_b_id
    and valid_until is null
    and valid_from < effective_date;

  insert into public.client_distance_history
    (client_a_id, client_b_id, distance_km, valid_from)
  values (new.client_a_id, new.client_b_id, new.distance_km, effective_date)
  on conflict (client_a_id, client_b_id, valid_from) do update
  set distance_km = excluded.distance_km,
      valid_until = null;

  return new;
end;
$$;

revoke all on function private.capture_client_distance_history() from public;

create trigger client_distances_capture_history
after insert or update of distance_km on public.client_distances
for each row execute function private.capture_client_distance_history();

create or replace view public.employee_daily_trips_with_distance
with (security_invoker = true)
as
with trips as (
  select t.employee_id, t.date, t.from_intervention_id, t.from_client_id,
         t.to_intervention_id, t.to_client_id,
         least(t.from_client_id, t.to_client_id) client_a_id,
         greatest(t.from_client_id, t.to_client_id) client_b_id
  from public.employee_daily_trips t
)
select tr.employee_id, tr.date, tr.from_intervention_id, tr.from_client_id,
       tr.to_intervention_id, tr.to_client_id, tr.client_a_id, tr.client_b_id,
       d.distance_km, d.distance_km is null distance_missing
from trips tr
left join lateral (
  select h.distance_km
  from public.client_distance_history h
  where h.client_a_id = tr.client_a_id
    and h.client_b_id = tr.client_b_id
    and h.valid_from <= tr.date
    and (h.valid_until is null or h.valid_until >= tr.date)
  order by h.valid_from desc
  limit 1
) d on true;

create or replace view public.interventions_progress_admin
with (security_invoker = true)
as
with base as (
  select i.id, i.date, i.employee_id, i.client_id, i.start_time_planned,
         i.end_time_planned,
         (extract(epoch from i.end_time_planned - i.start_time_planned) / 60)::integer planned_min,
         i.actual_start, i.actual_end, i.actual_duration_min, i.saved, i.status,
         i.completed_at, i.duplicated_from_intervention_id
  from public.interventions i
), lasts as (
  select b.id intervention_id,
    (select min(p.timestamp) from public.pointages p where p.intervention_id=b.id and p.type='start') last_start,
    (select p.latitude from public.pointages p where p.intervention_id=b.id and p.type='start' order by p.timestamp limit 1) last_start_latitude,
    (select p.longitude from public.pointages p where p.intervention_id=b.id and p.type='start' order by p.timestamp limit 1) last_start_longitude,
    (select max(p.timestamp) from public.pointages p where p.intervention_id=b.id and p.type='end') last_end,
    (select p.latitude from public.pointages p where p.intervention_id=b.id and p.type='end' order by p.timestamp desc limit 1) last_end_latitude,
    (select p.longitude from public.pointages p where p.intervention_id=b.id and p.type='end' order by p.timestamp desc limit 1) last_end_longitude
  from base b
), computed as (
  select b.*, l.last_start, l.last_end, l.last_start_latitude, l.last_start_longitude,
         l.last_end_latitude, l.last_end_longitude, c.name client_name,
         e.first_name, e.last_name,
         coalesce(ch.latitude,c.latitude) client_latitude,
         coalesce(ch.longitude,c.longitude) client_longitude,
         coalesce(b.actual_start,l.last_start) actual_start_calc,
         coalesce(b.actual_end,l.last_end) actual_end_calc,
         public.distance_meters(coalesce(ch.latitude,c.latitude),coalesce(ch.longitude,c.longitude),l.last_start_latitude,l.last_start_longitude) distance_start_m,
         public.distance_meters(coalesce(ch.latitude,c.latitude),coalesce(ch.longitude,c.longitude),l.last_end_latitude,l.last_end_longitude) distance_end_m
  from base b
  left join lasts l on l.intervention_id=b.id
  left join public.clients c on c.id=b.client_id
  left join public.employees e on e.id=b.employee_id
  left join lateral (
    select h.latitude,h.longitude
    from public.client_coordinate_history h
    where h.client_id=b.client_id and h.valid_from<=b.date
      and (h.valid_until is null or h.valid_until>=b.date)
    order by h.valid_from desc limit 1
  ) ch on true
), with_flags as (
  select c.*,
    case when c.actual_start_calc is not null and c.actual_end_calc is not null
      then greatest(0,(extract(epoch from c.actual_end_calc-c.actual_start_calc)/60)::integer)
      else c.actual_duration_min end actual_min_calc,
    case when c.actual_start_calc is null or c.actual_end_calc is null then false
      else greatest(0,(extract(epoch from c.actual_end_calc-c.actual_start_calc)/60)::integer) <= c.planned_min-5 end pb_time,
    case when c.distance_start_m is null then false else c.distance_start_m>=500 end pb_position_start,
    case when c.distance_end_m is null then false else c.distance_end_m>=500 end pb_position_end
  from computed c
)
select id,date,employee_id,client_id,client_name,
  concat_ws(' ',first_name,last_name) employee_name,
  start_time_planned,end_time_planned,planned_min,
  actual_start_calc actual_start,actual_end_calc actual_end,actual_min_calc actual_min,
  client_latitude,client_longitude,
  last_start_latitude actual_start_latitude,last_start_longitude actual_start_longitude,
  last_end_latitude actual_end_latitude,last_end_longitude actual_end_longitude,
  distance_start_m,distance_end_m,pb_time,pb_position_start,pb_position_end,
  case
    when saved=true then U&'valid\00E9'
    when actual_start_calc is null and actual_end_calc is null then 'en attente'
    when actual_start_calc is not null and actual_end_calc is null then 'en attente'
    when pb_time=true and (pb_position_start=true or pb_position_end=true) then 'Pb temps+position'
    when pb_position_start=true or pb_position_end=true then 'Pb position'
    when pb_time=true then 'Pb temps'
    else 'fait'
  end fait,
  saved,status,completed_at,duplicated_from_intervention_id
from with_flags;
