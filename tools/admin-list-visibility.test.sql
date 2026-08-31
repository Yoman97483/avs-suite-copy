begin;
set local statement_timeout = '45s';
create temporary table visibility_fingerprints (relation_name text primary key, fingerprint text) on commit drop;
do $$
declare rel text; hash text; expected text;
begin
  foreach rel in array array['public.interventions','public.pointages','public.client_distances','public.client_coordinate_history','public.client_distance_history','public.employee_month_summary','public.client_monthly_bilan','public.employee_daily_trips_with_distance','auth.users'] loop
    execute format('select md5(coalesce(string_agg(to_jsonb(t)::text, chr(10) order by to_jsonb(t)::text), '''')) from %s t',rel) into hash;
    insert into visibility_fingerprints values(rel,hash);
  end loop;
  insert into visibility_fingerprints select 'public.employees',md5(coalesce(string_agg((to_jsonb(e)-'hidden_from_admin_list')::text,chr(10) order by e.id),'')) from public.employees e;
  insert into visibility_fingerprints select 'public.clients',md5(coalesce(string_agg((to_jsonb(c)-'hidden_from_admin_list')::text,chr(10) order by c.id),'')) from public.clients c;
end $$;
update public.employees set hidden_from_admin_list=true;
update public.clients set hidden_from_admin_list=true;
do $$
declare rel text; hash text; expected text;
begin
  foreach rel in array array['public.interventions','public.pointages','public.client_distances','public.client_coordinate_history','public.client_distance_history','public.employee_month_summary','public.client_monthly_bilan','public.employee_daily_trips_with_distance','auth.users'] loop
    execute format('select md5(coalesce(string_agg(to_jsonb(t)::text, chr(10) order by to_jsonb(t)::text), '''')) from %s t',rel) into hash;
    select fingerprint into expected from visibility_fingerprints where relation_name=rel;
    if hash is distinct from expected then raise exception 'Unexpected change in %',rel; end if;
  end loop;
  select md5(coalesce(string_agg((to_jsonb(e)-'hidden_from_admin_list')::text,chr(10) order by e.id),'')) into hash from public.employees e;
  select fingerprint into expected from visibility_fingerprints where relation_name='public.employees';
  if hash is distinct from expected then raise exception 'Employee business data changed'; end if;
  select md5(coalesce(string_agg((to_jsonb(c)-'hidden_from_admin_list')::text,chr(10) order by c.id),'')) into hash from public.clients c;
  select fingerprint into expected from visibility_fingerprints where relation_name='public.clients';
  if hash is distinct from expected then raise exception 'Client business data changed'; end if;
  if exists(select 1 from public.employees where not hidden_from_admin_list) or exists(select 1 from public.clients where not hidden_from_admin_list) then raise exception 'Visibility filtering failed'; end if;
end $$;
rollback;
select 'PASS: visual hiding preserves business records, hours, distances and Auth; all test updates rolled back' as result,
(select count(*) from public.employees where hidden_from_admin_list) as hidden_employees,
(select count(*) from public.clients where hidden_from_admin_list) as hidden_clients;
