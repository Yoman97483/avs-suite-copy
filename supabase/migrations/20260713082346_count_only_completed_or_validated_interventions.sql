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
  join public.interventions_progress_admin ipa on ipa.id = i.id
  where ipa.fait in ('fait', 'valid' || chr(233))
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
  join public.interventions_progress_admin ipa on ipa.id = i.id
  where ipa.fait in ('fait', 'valid' || chr(233))
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
    greatest(
      0,
      extract(epoch from (
        i.date::timestamp + i.end_time_planned::interval
        - (i.date::timestamp + i.start_time_planned::interval)
      )) / 3600.0
    )
  ), 2) as hours_worked
from public.interventions i
join public.clients c on c.id = i.client_id
join public.interventions_progress_admin ipa on ipa.id = i.id
where ipa.fait in ('fait', 'valid' || chr(233))
  and i.start_time_planned is not null
  and i.end_time_planned is not null
group by
  c.id,
  c.name,
  date_trunc('month', i.date),
  extract(year from i.date),
  extract(month from i.date);

create or replace view public.employee_daily_suivi
with (security_invoker = true)
as
with interv as (
  select
    ipa.employee_id,
    ipa.date,
    ipa.id as intervention_id,
    ipa.client_name,
    ipa.start_time_planned,
    ipa.end_time_planned,
    ipa.fait as etat_logique,
    greatest(
      0::numeric,
      extract(epoch from (
        ipa.date::timestamp + ipa.end_time_planned::interval
        - (ipa.date::timestamp + ipa.start_time_planned::interval)
      )) / 3600.0
    ) as planned_hours
  from public.interventions_progress_admin ipa
  where ipa.fait in ('fait', 'valid' || chr(233))
    and ipa.start_time_planned is not null
    and ipa.end_time_planned is not null
),
trips as (
  select
    employee_id,
    date,
    from_intervention_id,
    distance_km
  from public.employee_daily_trips_with_distance
)
select
  interv.employee_id,
  e.first_name,
  e.last_name,
  interv.date,
  interv.intervention_id,
  interv.client_name,
  interv.start_time_planned,
  interv.end_time_planned,
  interv.planned_hours,
  interv.etat_logique,
  trips.distance_km as distance_to_next_km
from interv
left join trips
  on trips.employee_id = interv.employee_id
 and trips.date = interv.date
 and trips.from_intervention_id = interv.intervention_id
left join public.employees e on e.id = interv.employee_id
order by interv.employee_id, interv.date, interv.start_time_planned;

create or replace view public.missing_client_distances
with (security_invoker = true)
as
with completed_interventions as (
  select
    ipa.id,
    ipa.employee_id,
    ipa.date,
    ipa.start_time_planned,
    ipa.client_id
  from public.interventions_progress_admin ipa
  where ipa.client_id is not null
    and ipa.fait in ('fait', 'valid' || chr(233))
),
ordered_interventions as (
  select
    ci.employee_id,
    ci.date,
    ci.start_time_planned,
    ci.client_id as from_client_id,
    lead(ci.client_id) over (
      partition by ci.employee_id, ci.date
      order by ci.start_time_planned, ci.id
    ) as to_client_id
  from completed_interventions ci
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

create or replace function public.send_weekly_client_bilan_email()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_today_reunion date := (now() at time zone 'Indian/Reunion')::date;
  v_current_monday date;
  v_last_monday date;
  v_last_sunday date;
  v_html text;
  v_body jsonb;
  v_api_key text;
begin
  v_current_monday := (
    v_today_reunion - ((extract(dow from v_today_reunion)::int + 6) % 7)
  )::date;
  v_last_monday := v_current_monday - 7;
  v_last_sunday := v_current_monday - 1;
  v_api_key := private.ahasend_api_key();

  if v_api_key is null or v_api_key = '' then
    raise exception 'AhaSend API key missing in Supabase Vault';
  end if;

  select
    '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' ||
    '<title>Bilan heure client hebdomadaire AVS</title>' ||
    '<style>table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 13px; } ' ||
    'th, td { border: 1px solid #ccc; padding: 6px 8px; } th { background-color: #f0f0f0; } ' ||
    'td.num { text-align: right; }</style></head><body>' ||
    '<h2>Bilan heure client - hebdomadaire</h2><p>Periode du ' ||
    to_char(v_last_monday, 'DD/MM/YYYY') || ' au ' ||
    to_char(v_last_sunday, 'DD/MM/YYYY') || '</p><table><thead><tr>' ||
    '<th>Client</th><th>Heures effectuees</th></tr></thead><tbody>' ||
    coalesce((
      select string_agg(
        format(
          '<tr><td>%s</td><td class="num">%s</td></tr>',
          client_name,
          to_char(hours_worked, 'FM999999990.00')
        ),
        E'\n'
        order by client_name
      )
      from (
        select
          ipa.client_name,
          round(sum(greatest(
            0::numeric,
            extract(epoch from (
              ipa.end_time_planned - ipa.start_time_planned
            )) / 3600.0
          ))::numeric, 2) as hours_worked
        from public.interventions_progress_admin ipa
        where ipa.date between v_last_monday and v_last_sunday
          and ipa.fait in ('fait', 'valid' || chr(233))
        group by ipa.client_name
      ) s
    ), '<tr><td colspan="2">Aucune heure sur cette periode.</td></tr>') ||
    '</tbody></table></body></html>'
  into v_html;

  v_body := jsonb_build_object(
    'from', jsonb_build_object(
      'email', 'info@avs-admin.re',
      'name', 'AVS Bilan Heure Client'
    ),
    'recipients', jsonb_build_array(jsonb_build_object(
      'email', 'avs.run974@gmail.com',
      'name', 'Administrateur AVS'
    )),
    'content', jsonb_build_object(
      'subject', format(
        'Bilan heure client hebdomadaire AVS (%s - %s)',
        to_char(v_last_monday, 'DD/MM/YYYY'),
        to_char(v_last_sunday, 'DD/MM/YYYY')
      ),
      'text_body', 'Veuillez consulter la version HTML de ce message.',
      'html_body', v_html
    )
  );

  perform net.http_post(
    'https://api.ahasend.com/v1/email/send',
    v_body,
    '{}'::jsonb,
    jsonb_build_object(
      'X-Api-Key', v_api_key,
      'Content-Type', 'application/json'
    ),
    10000
  );

  return 'OK - email hebdomadaire client demande';
end;
$$;

grant select on public.employee_daily_trips to authenticated;
grant select on public.employee_month_summary to authenticated;
grant select on public.client_monthly_bilan to authenticated;
grant select on public.employee_daily_suivi to authenticated;
grant select on public.missing_client_distances to authenticated;

revoke all on public.employee_daily_trips from anon;
revoke all on public.employee_month_summary from anon;
revoke all on public.client_monthly_bilan from anon;
revoke all on public.employee_daily_suivi from anon;
revoke all on public.missing_client_distances from anon;

notify pgrst, 'reload schema';
