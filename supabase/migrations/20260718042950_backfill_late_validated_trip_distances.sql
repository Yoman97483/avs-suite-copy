-- A distance can be calculated after an administrator validates an older
-- intervention. In that case it must cover the trip that required it.
create or replace function private.capture_client_distance_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_date date := (now() at time zone 'Indian/Reunion')::date;
  first_required_date date;
begin
  if tg_op = 'UPDATE' and old.distance_km is not distinct from new.distance_km then
    return new;
  end if;

  if tg_op = 'INSERT' then
    select min(t.date)
    into first_required_date
    from public.employee_daily_trips t
    where least(t.from_client_id, t.to_client_id) = new.client_a_id
      and greatest(t.from_client_id, t.to_client_id) = new.client_b_id;

    effective_date := least(
      effective_date,
      coalesce(first_required_date, effective_date)
    );
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

-- Repair distances that were first calculated after their first completed or
-- administrator-validated trip. Existing earlier history remains untouched.
with first_trip_by_pair as (
  select
    least(t.from_client_id, t.to_client_id) as client_a_id,
    greatest(t.from_client_id, t.to_client_id) as client_b_id,
    min(t.date) as first_trip_date
  from public.employee_daily_trips t
  group by 1, 2
), first_history_by_pair as (
  select
    h.client_a_id,
    h.client_b_id,
    min(h.valid_from) as first_history_date
  from public.client_distance_history h
  group by h.client_a_id, h.client_b_id
)
update public.client_distance_history h
set valid_from = t.first_trip_date
from first_trip_by_pair t
join first_history_by_pair hb
  on hb.client_a_id = t.client_a_id
 and hb.client_b_id = t.client_b_id
where h.client_a_id = t.client_a_id
  and h.client_b_id = t.client_b_id
  and h.valid_from = hb.first_history_date
  and t.first_trip_date < hb.first_history_date;
