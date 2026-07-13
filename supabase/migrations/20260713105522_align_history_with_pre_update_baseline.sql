-- The preservation boundary is the database state immediately before the
-- 13 July bulk update, including the three corrections already made that day.
update public.client_coordinate_history
set latitude = -21.325638, longitude = 55.483764
where client_id = '9f46ad57-6f98-4f41-875f-676b18cd633d'::uuid
  and valid_from = date '1900-01-01';

update public.client_coordinate_history
set latitude = -21.2679446, longitude = 55.5003392
where client_id = '1fe001bf-c222-44ca-8d7f-3557dce13e18'::uuid
  and valid_from = date '1900-01-01';

update public.client_coordinate_history
set latitude = -21.296817, longitude = 55.495065
where client_id = '3ea395c0-8e4d-42dd-a572-6befa3a1156e'::uuid
  and valid_from = date '1900-01-01';

update public.client_distance_history h
set distance_km = d.distance_km
from public.client_distances d
where h.client_a_id = d.client_a_id
  and h.client_b_id = d.client_b_id
  and h.valid_from = date '1900-01-01';
