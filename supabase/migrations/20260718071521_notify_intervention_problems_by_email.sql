-- Queue one alert after an employee ends an intervention with a detected problem.
create table if not exists private.intervention_problem_email_notifications (
  intervention_id uuid primary key references public.interventions(id) on delete cascade,
  pointage_id uuid not null unique references public.pointages(id) on delete cascade,
  problem_status text not null,
  employee_email text,
  request_id bigint,
  delivery_state text not null default 'queued',
  error_message text,
  created_at timestamptz not null default now()
);

revoke all on table private.intervention_problem_email_notifications from public;

create or replace function private.html_escape(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(
    replace(
      replace(
        replace(
          replace(coalesce(value, ''), '&', '&amp;'),
          '<', '&lt;'
        ),
        '>', '&gt;'
      ),
      '"', '&quot;'
    ),
    '''', '&#39;'
  )
$$;

revoke all on function private.html_escape(text) from public;

create or replace function private.notify_intervention_problem()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_problem_status text;
  v_display_status text;
  v_employee_name text;
  v_employee_email text;
  v_client_name text;
  v_date date;
  v_start_time time;
  v_end_time time;
  v_actual_start timestamptz;
  v_actual_end timestamptz;
  v_planned_min integer;
  v_actual_min integer;
  v_distance_start_m double precision;
  v_distance_end_m double precision;
  v_api_key text;
  v_recipients jsonb;
  v_html text;
  v_text text;
  v_body jsonb;
  v_request_id bigint;
begin
  if new.type <> 'end' then
    return new;
  end if;

  select
    ipa.fait,
    ipa.employee_name,
    e.email,
    ipa.client_name,
    ipa.date,
    ipa.start_time_planned,
    ipa.end_time_planned,
    ipa.actual_start,
    ipa.actual_end,
    ipa.planned_min,
    ipa.actual_min,
    ipa.distance_start_m,
    ipa.distance_end_m
  into
    v_problem_status,
    v_employee_name,
    v_employee_email,
    v_client_name,
    v_date,
    v_start_time,
    v_end_time,
    v_actual_start,
    v_actual_end,
    v_planned_min,
    v_actual_min,
    v_distance_start_m,
    v_distance_end_m
  from public.interventions_progress_admin ipa
  left join public.employees e on e.id = ipa.employee_id
  where ipa.id = new.intervention_id;

  if lower(coalesce(v_problem_status, '')) not in (
    'pb temps',
    'pb position',
    'pb temps+position',
    'pb position+temps'
  ) then
    return new;
  end if;

  v_display_status := case
    when lower(v_problem_status) in ('pb temps+position', 'pb position+temps') then 'pb position+temps'
    when lower(v_problem_status) = 'pb position' then 'pb position'
    else 'pb temps'
  end;

  insert into private.intervention_problem_email_notifications (
    intervention_id,
    pointage_id,
    problem_status,
    employee_email
  )
  values (
    new.intervention_id,
    new.id,
    v_display_status,
    nullif(btrim(v_employee_email), '')
  )
  on conflict (intervention_id) do nothing;

  if not found then
    return new;
  end if;

  select decrypted_secret
  into v_api_key
  from vault.decrypted_secrets
  where name = 'ahasend_api_key'
  order by created_at desc
  limit 1;

  if coalesce(v_api_key, '') = '' then
    raise exception 'AhaSend API key missing in Supabase Vault';
  end if;

  v_recipients := jsonb_build_array(
    jsonb_build_object(
      'email', 'avs.run974@gmail.com',
      'name', 'Administrateur AVS'
    )
  );

  if nullif(btrim(v_employee_email), '') is not null
     and lower(btrim(v_employee_email)) <> 'avs.run974@gmail.com' then
    v_recipients := v_recipients || jsonb_build_array(
      jsonb_build_object(
        'email', btrim(v_employee_email),
        'name', coalesce(nullif(btrim(v_employee_name), ''), 'Employé AVS')
      )
    );
  end if;

  v_text := format(
    E'Une anomalie a été détectée lors de la validation d’une intervention.\n\nStatut : %s\nEmployé : %s\nClient : %s\nDate : %s\nHoraire prévu : %s - %s\nHoraire pointé : %s - %s\nDurée prévue : %s min\nDurée pointée : %s min\nDistance au client au début : %s m\nDistance au client à la fin : %s m',
    v_display_status,
    coalesce(v_employee_name, 'Non renseigné'),
    coalesce(v_client_name, 'Non renseigné'),
    to_char(v_date, 'DD/MM/YYYY'),
    to_char(v_start_time, 'HH24:MI'),
    to_char(v_end_time, 'HH24:MI'),
    coalesce(to_char(v_actual_start at time zone 'Indian/Reunion', 'DD/MM/YYYY HH24:MI'), 'Non renseigné'),
    coalesce(to_char(v_actual_end at time zone 'Indian/Reunion', 'DD/MM/YYYY HH24:MI'), 'Non renseigné'),
    coalesce(v_planned_min::text, 'Non renseignée'),
    coalesce(v_actual_min::text, 'Non renseignée'),
    coalesce(round(v_distance_start_m)::text, 'Non renseignée'),
    coalesce(round(v_distance_end_m)::text, 'Non renseignée')
  );

  v_html := format(
    '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Alerte intervention AVS</title></head><body style="font-family:Arial,sans-serif;color:#172033"><h2>Alerte intervention AVS</h2><p>Une anomalie a été détectée lors de la validation d’une intervention.</p><table style="border-collapse:collapse"><tr><th style="text-align:left;padding:6px 12px 6px 0">Statut</th><td style="padding:6px"><strong>%s</strong></td></tr><tr><th style="text-align:left;padding:6px 12px 6px 0">Employé</th><td style="padding:6px">%s</td></tr><tr><th style="text-align:left;padding:6px 12px 6px 0">Client</th><td style="padding:6px">%s</td></tr><tr><th style="text-align:left;padding:6px 12px 6px 0">Date</th><td style="padding:6px">%s</td></tr><tr><th style="text-align:left;padding:6px 12px 6px 0">Horaire prévu</th><td style="padding:6px">%s - %s</td></tr><tr><th style="text-align:left;padding:6px 12px 6px 0">Horaire pointé</th><td style="padding:6px">%s - %s</td></tr><tr><th style="text-align:left;padding:6px 12px 6px 0">Durées</th><td style="padding:6px">%s min prévues / %s min pointées</td></tr><tr><th style="text-align:left;padding:6px 12px 6px 0">Distances GPS</th><td style="padding:6px">Début : %s m / Fin : %s m</td></tr></table></body></html>',
    private.html_escape(v_display_status),
    private.html_escape(coalesce(v_employee_name, 'Non renseigné')),
    private.html_escape(coalesce(v_client_name, 'Non renseigné')),
    to_char(v_date, 'DD/MM/YYYY'),
    to_char(v_start_time, 'HH24:MI'),
    to_char(v_end_time, 'HH24:MI'),
    private.html_escape(coalesce(to_char(v_actual_start at time zone 'Indian/Reunion', 'DD/MM/YYYY HH24:MI'), 'Non renseigné')),
    private.html_escape(coalesce(to_char(v_actual_end at time zone 'Indian/Reunion', 'DD/MM/YYYY HH24:MI'), 'Non renseigné')),
    coalesce(v_planned_min::text, 'Non renseignée'),
    coalesce(v_actual_min::text, 'Non renseignée'),
    coalesce(round(v_distance_start_m)::text, 'Non renseignée'),
    coalesce(round(v_distance_end_m)::text, 'Non renseignée')
  );

  v_body := jsonb_build_object(
    'from', jsonb_build_object(
      'email', 'info@avs-admin.re',
      'name', 'AVS - Alerte intervention'
    ),
    'recipients', v_recipients,
    'content', jsonb_build_object(
      'subject', format(
        'AVS - %s - %s - %s',
        v_display_status,
        coalesce(v_employee_name, 'Employé'),
        to_char(v_date, 'DD/MM/YYYY')
      ),
      'text_body', v_text,
      'html_body', v_html
    )
  );

  v_request_id := net.http_post(
    'https://api.ahasend.com/v1/email/send',
    v_body,
    '{}'::jsonb,
    jsonb_build_object(
      'X-Api-Key', v_api_key,
      'Content-Type', 'application/json'
    ),
    10000
  );

  update private.intervention_problem_email_notifications
  set request_id = v_request_id,
      delivery_state = 'queued'
  where intervention_id = new.intervention_id;

  return new;
exception
  when others then
    begin
      insert into private.intervention_problem_email_notifications (
        intervention_id,
        pointage_id,
        problem_status,
        employee_email,
        delivery_state,
        error_message
      )
      values (
        new.intervention_id,
        new.id,
        coalesce(v_display_status, coalesce(v_problem_status, 'inconnu')),
        nullif(btrim(v_employee_email), ''),
        'queue_failed',
        sqlerrm
      )
      on conflict (intervention_id) do update
      set delivery_state = 'queue_failed',
          error_message = excluded.error_message;
    exception
      when others then
        null;
    end;

    raise warning 'Impossible de mettre en file la notification de problème pour l''intervention %: %', new.intervention_id, sqlerrm;
    return new;
end;
$$;

revoke all on function private.notify_intervention_problem() from public;

drop trigger if exists notify_intervention_problem_after_pointage on public.pointages;

create trigger notify_intervention_problem_after_pointage
after insert on public.pointages
for each row
when (new.type = 'end')
execute function private.notify_intervention_problem();
