create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace view public.employee_daily_trips
with (security_invoker = true)
as
with base as (
  select
    i.id,
    i.employee_id,
    i.client_id,
    i.date,
    coalesce(i.actual_start, (i.date::timestamp + i.start_time_planned::interval)::timestamptz) as sort_ts
  from public.interventions i
  left join public.interventions_progress_admin ipa on ipa.id = i.id
  where ipa.fait <> 'en attente'
),
sequenced as (
  select
    base.employee_id,
    base.date,
    base.id as from_intervention_id,
    base.client_id as from_client_id,
    lead(base.id) over (partition by base.employee_id, base.date order by base.sort_ts) as to_intervention_id,
    lead(base.client_id) over (partition by base.employee_id, base.date order by base.sort_ts) as to_client_id
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

create or replace view public.employee_daily_trips_with_distance
with (security_invoker = true)
as
with trips as (
  select
    t.employee_id,
    t.date,
    t.from_intervention_id,
    t.from_client_id,
    t.to_intervention_id,
    t.to_client_id,
    least(t.from_client_id, t.to_client_id) as client_a_id,
    greatest(t.from_client_id, t.to_client_id) as client_b_id
  from public.employee_daily_trips t
),
joined as (
  select
    tr.*,
    d.distance_km,
    d.distance_km is null as distance_missing
  from trips tr
  left join public.client_distances d
    on d.client_a_id = tr.client_a_id
   and d.client_b_id = tr.client_b_id
)
select
  employee_id,
  date,
  from_intervention_id,
  from_client_id,
  to_intervention_id,
  to_client_id,
  client_a_id,
  client_b_id,
  distance_km,
  distance_missing
from joined;

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
      extract(epoch from (ipa.date::timestamp + ipa.end_time_planned::interval)
        - (ipa.date::timestamp + ipa.start_time_planned::interval)) / 3600.0
    ) as planned_hours
  from public.interventions_progress_admin ipa
  where ipa.fait <> 'en attente'
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

create or replace function private.ahasend_api_key()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'ahasend_api_key'
  order by created_at desc
  limit 1
$$;

revoke all on function private.ahasend_api_key() from public;

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
  v_current_monday := (v_today_reunion - ((extract(dow from v_today_reunion)::int + 6) % 7))::date;
  v_last_monday := v_current_monday - 7;
  v_last_sunday := v_current_monday - 1;
  v_api_key := private.ahasend_api_key();

  if v_api_key is null or v_api_key = '' then
    raise exception 'AhaSend API key missing in Supabase Vault';
  end if;

  select
    '<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Bilan heure client hebdomadaire AVS</title>
<style>
table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 13px; }
th, td { border: 1px solid #ccc; padding: 6px 8px; }
th { background-color: #f0f0f0; }
td.num { text-align: right; }
</style>
</head>
<body>
<h2>Bilan heure client - hebdomadaire</h2>
<p>Période du ' || to_char(v_last_monday, 'DD/MM/YYYY') || ' au ' || to_char(v_last_sunday, 'DD/MM/YYYY') || '</p>
<table>
  <thead>
    <tr>
      <th>Client</th>
      <th>Heures effectuées</th>
    </tr>
  </thead>
  <tbody>' ||
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
        round(sum(greatest(0::numeric, extract(epoch from ipa.end_time_planned - ipa.start_time_planned) / 3600.0))::numeric, 2) as hours_worked
      from public.interventions_progress_admin ipa
      where ipa.date between v_last_monday and v_last_sunday
        and ipa.fait <> 'en attente'
      group by ipa.client_name
    ) s
  ), '<tr><td colspan="2">Aucune heure sur cette période.</td></tr>') ||
  '</tbody>
</table>
</body>
</html>'
  into v_html;

  v_body := jsonb_build_object(
    'from', jsonb_build_object('email', 'info@avs-admin.re', 'name', 'AVS Bilan Heure Client'),
    'recipients', jsonb_build_array(jsonb_build_object('email', 'avs.run974@gmail.com', 'name', 'Administrateur AVS')),
    'content', jsonb_build_object(
      'subject', format('Bilan heure client hebdomadaire AVS (%s - %s)', to_char(v_last_monday, 'DD/MM/YYYY'), to_char(v_last_sunday, 'DD/MM/YYYY')),
      'text_body', 'Veuillez consulter la version HTML de ce message.',
      'html_body', v_html
    )
  );

  perform net.http_post(
    'https://api.ahasend.com/v1/email/send',
    v_body,
    '{}'::jsonb,
    jsonb_build_object('X-Api-Key', v_api_key, 'Content-Type', 'application/json'),
    10000
  );

  return 'OK - email hebdomadaire client demandé';
end;
$$;

create or replace function public.send_monthly_client_bilan_email()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_today_reunion date := (now() at time zone 'Indian/Reunion')::date;
  v_first_day date;
  v_last_day date;
  v_html text;
  v_body jsonb;
  v_api_key text;
begin
  if extract(day from v_today_reunion)::int <> 1 then
    return format('SKIPPED - date Réunion %s, envoi mensuel prévu le 1er', v_today_reunion::text);
  end if;

  v_first_day := date_trunc('month', v_today_reunion - interval '1 month')::date;
  v_last_day := (date_trunc('month', v_today_reunion)::date - 1);
  v_api_key := private.ahasend_api_key();

  if v_api_key is null or v_api_key = '' then
    raise exception 'AhaSend API key missing in Supabase Vault';
  end if;

  select
    '<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Bilan heure client mensuel AVS</title>
<style>
table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 13px; }
th, td { border: 1px solid #ccc; padding: 6px 8px; }
th { background-color: #f0f0f0; }
td.num { text-align: right; }
</style>
</head>
<body>
<h2>Bilan heure client - mensuel</h2>
<p>Période du ' || to_char(v_first_day, 'DD/MM/YYYY') || ' au ' || to_char(v_last_day, 'DD/MM/YYYY') || '</p>
<table>
  <thead>
    <tr>
      <th>Client</th>
      <th>Heures effectuées</th>
    </tr>
  </thead>
  <tbody>' ||
  coalesce((
    select string_agg(
      format('<tr><td>%s</td><td class="num">%s</td></tr>', client_name, to_char(hours_worked, 'FM999999990.00')),
      E'\n'
      order by client_name
    )
    from public.client_monthly_bilan
    where year = extract(year from v_first_day)::int
      and month_number = extract(month from v_first_day)::int
  ), '<tr><td colspan="2">Aucune heure sur cette période.</td></tr>') ||
  '</tbody>
</table>
</body>
</html>'
  into v_html;

  v_body := jsonb_build_object(
    'from', jsonb_build_object('email', 'info@avs-admin.re', 'name', 'AVS Bilan Heure Client'),
    'recipients', jsonb_build_array(jsonb_build_object('email', 'avs.run974@gmail.com', 'name', 'Administrateur AVS')),
    'content', jsonb_build_object(
      'subject', format('Bilan heure client mensuel AVS (%s)', to_char(v_first_day, 'MM/YYYY')),
      'text_body', 'Veuillez consulter la version HTML de ce message.',
      'html_body', v_html
    )
  );

  perform net.http_post(
    'https://api.ahasend.com/v1/email/send',
    v_body,
    '{}'::jsonb,
    jsonb_build_object('X-Api-Key', v_api_key, 'Content-Type', 'application/json'),
    10000
  );

  return 'OK - email mensuel client demandé';
end;
$$;

create or replace function public.send_weekly_employee_dailies_email()
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
  v_current_monday := (v_today_reunion - ((extract(dow from v_today_reunion)::int + 6) % 7))::date;
  v_last_monday := v_current_monday - 7;
  v_last_sunday := v_current_monday - 1;
  v_api_key := private.ahasend_api_key();

  if v_api_key is null or v_api_key = '' then
    raise exception 'AhaSend API key missing in Supabase Vault';
  end if;

  select html_content
  into v_html
  from (
    with rows as (
      select
        eds.first_name,
        eds.last_name,
        eds.date,
        eds.client_name,
        eds.start_time_planned,
        eds.planned_hours,
        eds.etat_logique,
        eds.distance_to_next_km
      from public.employee_daily_suivi eds
      where eds.date between v_last_monday and v_last_sunday
      order by eds.last_name, eds.first_name, eds.date, eds.start_time_planned
    ),
    html_rows as (
      select coalesce(
        string_agg(
          format(
            '<tr><td>%s %s</td><td>%s</td><td>%s</td><td>%s</td><td style="text-align:right;">%s</td><td>%s</td><td style="text-align:right;">%s</td></tr>',
            coalesce(first_name, ''),
            coalesce(last_name, ''),
            to_char(date, 'DD/MM/YYYY'),
            coalesce(client_name, ''),
            coalesce(to_char(start_time_planned, 'HH24:MI'), ''),
            coalesce(to_char(planned_hours, 'FM999999990.00'), '0.00'),
            coalesce(etat_logique, ''),
            case when distance_to_next_km is null then '' else to_char(distance_to_next_km, 'FM999999990.00') end
          ),
          E'\n'
        ),
        '<tr><td colspan="7">Aucune intervention sur cette période.</td></tr>'
      ) as rows_html
      from rows
    ),
    html_totals as (
      select coalesce(
        string_agg(
          format(
            '<tr><td>%s %s</td><td style="text-align:right;">%s</td><td style="text-align:right;">%s</td></tr>',
            coalesce(first_name, ''),
            coalesce(last_name, ''),
            to_char(total_hours, 'FM999999990.00'),
            to_char(total_km, 'FM999999990.00')
          ),
          E'\n'
          order by last_name, first_name
        ),
        '<tr><td colspan="3">Aucun total disponible.</td></tr>'
      ) as totals_html
      from (
        select
          first_name,
          last_name,
          sum(planned_hours) as total_hours,
          sum(coalesce(distance_to_next_km, 0)) as total_km
        from rows
        group by first_name, last_name
      ) agg
    )
    select
      '<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Bilan heure employé hebdomadaire AVS</title>
<style>
table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 13px; }
th, td { border: 1px solid #ccc; padding: 4px 6px; }
th { background-color: #f0f0f0; }
</style>
</head>
<body>
<h2>Bilan heure employé - hebdomadaire</h2>
<p>Période du ' || to_char(v_last_monday, 'DD/MM/YYYY') || ' au ' || to_char(v_last_sunday, 'DD/MM/YYYY') || '</p>
<table>
<thead><tr><th>Employé</th><th>Date</th><th>Client</th><th>Heure début prévue</th><th>Durée prévue (h)</th><th>État</th><th>Distance vers client suivant (km)</th></tr></thead>
<tbody>' || (select rows_html from html_rows) || '</tbody>
</table>
<h3>Récapitulatif hebdomadaire par employé</h3>
<table>
<thead><tr><th>Employé</th><th>Heures totales prévues (h)</th><th>Distance totale vers client suivant (km)</th></tr></thead>
<tbody>' || (select totals_html from html_totals) || '</tbody>
</table>
</body>
</html>' as html_content
  ) sub;

  v_body := jsonb_build_object(
    'from', jsonb_build_object('email', 'info@avs-admin.re', 'name', 'AVS Bilan Heure Employé'),
    'recipients', jsonb_build_array(jsonb_build_object('email', 'avs.run974@gmail.com', 'name', 'Administrateur AVS')),
    'content', jsonb_build_object(
      'subject', format('Bilan heure employé hebdomadaire AVS (%s - %s)', to_char(v_last_monday, 'DD/MM/YYYY'), to_char(v_last_sunday, 'DD/MM/YYYY')),
      'text_body', 'Veuillez consulter la version HTML de ce message.',
      'html_body', v_html
    )
  );

  perform net.http_post(
    'https://api.ahasend.com/v1/email/send',
    v_body,
    '{}'::jsonb,
    jsonb_build_object('X-Api-Key', v_api_key, 'Content-Type', 'application/json'),
    10000
  );

  return 'OK - email hebdomadaire employé demandé';
end;
$$;

create or replace function public.send_monthly_employee_dailies_email()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_today_reunion date := (now() at time zone 'Indian/Reunion')::date;
  v_first_day date;
  v_last_day date;
  v_html text;
  v_body jsonb;
  v_api_key text;
begin
  if extract(day from v_today_reunion)::int <> 1 then
    return format('SKIPPED - date Réunion %s, envoi mensuel prévu le 1er', v_today_reunion::text);
  end if;

  v_first_day := date_trunc('month', v_today_reunion - interval '1 month')::date;
  v_last_day := (date_trunc('month', v_today_reunion)::date - 1);
  v_api_key := private.ahasend_api_key();

  if v_api_key is null or v_api_key = '' then
    raise exception 'AhaSend API key missing in Supabase Vault';
  end if;

  select html_content
  into v_html
  from (
    with rows as (
      select
        eds.first_name,
        eds.last_name,
        eds.date,
        eds.client_name,
        eds.start_time_planned,
        eds.planned_hours,
        eds.etat_logique,
        eds.distance_to_next_km
      from public.employee_daily_suivi eds
      where eds.date between v_first_day and v_last_day
      order by eds.last_name, eds.first_name, eds.date, eds.start_time_planned
    ),
    html_rows as (
      select coalesce(
        string_agg(
          format(
            '<tr><td>%s %s</td><td>%s</td><td>%s</td><td>%s</td><td style="text-align:right;">%s</td><td>%s</td><td style="text-align:right;">%s</td></tr>',
            coalesce(first_name, ''),
            coalesce(last_name, ''),
            to_char(date, 'DD/MM/YYYY'),
            coalesce(client_name, ''),
            coalesce(to_char(start_time_planned, 'HH24:MI'), ''),
            coalesce(to_char(planned_hours, 'FM999999990.00'), '0.00'),
            coalesce(etat_logique, ''),
            case when distance_to_next_km is null then '' else to_char(distance_to_next_km, 'FM999999990.00') end
          ),
          E'\n'
        ),
        '<tr><td colspan="7">Aucune intervention sur cette période.</td></tr>'
      ) as rows_html
      from rows
    ),
    html_totals as (
      select coalesce(
        string_agg(
          format(
            '<tr><td>%s %s</td><td style="text-align:right;">%s</td><td style="text-align:right;">%s</td></tr>',
            coalesce(first_name, ''),
            coalesce(last_name, ''),
            to_char(total_hours, 'FM999999990.00'),
            to_char(total_km, 'FM999999990.00')
          ),
          E'\n'
          order by last_name, first_name
        ),
        '<tr><td colspan="3">Aucun total disponible.</td></tr>'
      ) as totals_html
      from (
        select
          first_name,
          last_name,
          sum(planned_hours) as total_hours,
          sum(coalesce(distance_to_next_km, 0)) as total_km
        from rows
        group by first_name, last_name
      ) agg
    )
    select
      '<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Bilan heure employé mensuel AVS</title>
<style>
table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 13px; }
th, td { border: 1px solid #ccc; padding: 4px 6px; }
th { background-color: #f0f0f0; }
</style>
</head>
<body>
<h2>Bilan heure employé - mensuel</h2>
<p>Période du ' || to_char(v_first_day, 'DD/MM/YYYY') || ' au ' || to_char(v_last_day, 'DD/MM/YYYY') || '</p>
<table>
<thead><tr><th>Employé</th><th>Date</th><th>Client</th><th>Heure début prévue</th><th>Durée prévue (h)</th><th>État</th><th>Distance vers client suivant (km)</th></tr></thead>
<tbody>' || (select rows_html from html_rows) || '</tbody>
</table>
<h3>Récapitulatif mensuel par employé</h3>
<table>
<thead><tr><th>Employé</th><th>Heures totales prévues (h)</th><th>Distance totale vers client suivant (km)</th></tr></thead>
<tbody>' || (select totals_html from html_totals) || '</tbody>
</table>
</body>
</html>' as html_content
  ) sub;

  v_body := jsonb_build_object(
    'from', jsonb_build_object('email', 'info@avs-admin.re', 'name', 'AVS Bilan Heure Employé'),
    'recipients', jsonb_build_array(jsonb_build_object('email', 'avs.run974@gmail.com', 'name', 'Administrateur AVS')),
    'content', jsonb_build_object(
      'subject', format('Bilan heure employé mensuel AVS (%s)', to_char(v_first_day, 'MM/YYYY')),
      'text_body', 'Veuillez consulter la version HTML de ce message.',
      'html_body', v_html
    )
  );

  perform net.http_post(
    'https://api.ahasend.com/v1/email/send',
    v_body,
    '{}'::jsonb,
    jsonb_build_object('X-Api-Key', v_api_key, 'Content-Type', 'application/json'),
    10000
  );

  return 'OK - email mensuel employé demandé';
end;
$$;

revoke all on function public.send_weekly_client_bilan_email() from public;
revoke all on function public.send_monthly_client_bilan_email() from public;
revoke all on function public.send_weekly_employee_dailies_email() from public;
revoke all on function public.send_monthly_employee_dailies_email() from public;

grant select on public.employee_daily_trips to authenticated;
grant select on public.employee_daily_trips_with_distance to authenticated;
grant select on public.employee_daily_suivi to authenticated;
revoke all on public.employee_daily_trips from anon;
revoke all on public.employee_daily_trips_with_distance from anon;
revoke all on public.employee_daily_suivi from anon;

do $$
begin
  perform cron.unschedule('avs_weekly_client_bilan_email');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.unschedule('avs_weekly_employee_bilan_email');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.unschedule('avs_monthly_client_bilan_email');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.unschedule('avs_monthly_employee_bilan_email');
exception when others then
  null;
end $$;

select cron.schedule(
  'avs_weekly_client_bilan_email',
  '0 22 * * 0',
  $$select public.send_weekly_client_bilan_email();$$
);

select cron.schedule(
  'avs_weekly_employee_bilan_email',
  '0 22 * * 0',
  $$select public.send_weekly_employee_dailies_email();$$
);

select cron.schedule(
  'avs_monthly_client_bilan_email',
  '0 22 28-31 * *',
  $$select public.send_monthly_client_bilan_email();$$
);

select cron.schedule(
  'avs_monthly_employee_bilan_email',
  '0 22 28-31 * *',
  $$select public.send_monthly_employee_dailies_email();$$
);

notify pgrst, 'reload schema';
