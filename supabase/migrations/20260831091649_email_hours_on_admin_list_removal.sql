-- Capture a historical report when an administrator hides a client or employee.
-- No business record, Auth account, or reporting view is removed or changed.
create table private.admin_removal_email_notifications (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('client', 'employee')),
  entity_id uuid not null,
  snapshot jsonb not null,
  recipient text not null,
  request_id bigint not null unique,
  created_at timestamptz not null default now()
);
alter table private.admin_removal_email_notifications enable row level security;
revoke all on private.admin_removal_email_notifications from public, anon, authenticated;

-- Best-effort hardening: managed Supabase owns these objects and may ignore
-- grants from postgres. The net schema must also stay outside the Data API.
grant all on net.http_request_queue, net._http_response to postgres, service_role;
revoke all on net.http_request_queue, net._http_response from public, anon, authenticated;

create function private.admin_removal_hours_snapshot(p_entity_type text, p_entity_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_name text;
  v_months jsonb;
  v_total numeric;
begin
  if p_entity_type = 'client' then
    select c.name into strict v_name from public.clients c where c.id = p_entity_id;
    select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'hours', m.hours) order by m.month), '[]'::jsonb),
      coalesce(sum(m.hours), 0)
    into v_months, v_total
    from (
      select make_date(b.year, b.month_number, 1) as month, round(b.hours_worked, 2) as hours
      from public.client_monthly_bilan b where b.client_id = p_entity_id
    ) m;
  elsif p_entity_type = 'employee' then
    select concat_ws(' ', e.first_name, e.last_name) into strict v_name
      from public.employees e where e.id = p_entity_id;
    select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'hours', m.hours) order by m.month), '[]'::jsonb),
      coalesce(sum(m.hours), 0)
    into v_months, v_total
    from (
      select b.month, round(b.hours_worked, 2) as hours
      from public.employee_month_summary b where b.employee_id = p_entity_id
    ) m;
  else
    raise exception 'Unsupported report entity: %', p_entity_type;
  end if;
  return jsonb_build_object('name', v_name, 'months', v_months, 'total_hours', v_total);
end;
$$;
revoke all on function private.admin_removal_hours_snapshot(text, uuid) from public, anon, authenticated;

-- Privileged trigger needed to access Vault and the private notification ledger.
-- Table UPDATE policies restrict the initiating change to administrators.
create function private.email_hours_on_admin_list_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity_type text;
  v_label text;
  v_snapshot jsonb;
  v_month jsonb;
  v_month_label text;
  v_hours text;
  v_total text;
  v_subject text;
  v_text text;
  v_html text;
  v_rows text := '';
  v_api_key text;
  v_request_id bigint;
  v_recipient constant text := 'avs.run974@gmail.com';
  v_month_names constant text[] := array['Janvier','Février','Mars','Avril','Mai','Juin',
    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
begin
  if old.hidden_from_admin_list or not new.hidden_from_admin_list then
    return new;
  end if;
  if auth.uid() is not null and not private.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  if tg_table_schema = 'public' and tg_table_name = 'clients' then
    v_entity_type := 'client';
    v_label := 'Client';
  elsif tg_table_schema = 'public' and tg_table_name = 'employees' then
    v_entity_type := 'employee';
    v_label := 'Employé';
  else
    raise exception 'Unexpected notification source';
  end if;

  v_snapshot := private.admin_removal_hours_snapshot(v_entity_type, new.id);
  v_subject := format('AVS - Récapitulatif des heures - %s : %s', v_label, v_snapshot->>'name');
  v_text := format(E'%s : %s\nRetiré de la liste le %s (heure de La Réunion).\n\nHeures comptabilisées par mois :\n',
    v_label, v_snapshot->>'name', to_char(now() at time zone 'Indian/Reunion', 'DD/MM/YYYY à HH24:MI'));

  for v_month in select value from jsonb_array_elements(v_snapshot->'months') loop
    v_month_label := v_month_names[extract(month from (v_month->>'month')::date)::int]
      || ' ' || extract(year from (v_month->>'month')::date)::int;
    v_hours := replace(to_char((v_month->>'hours')::numeric, 'FM999999999990.00'), '.', ',');
    v_rows := v_rows || format('<tr><td>%s</td><td style="text-align:right">%s h</td></tr>', v_month_label, v_hours);
    v_text := v_text || format(E'%s : %s h\n', v_month_label, v_hours);
  end loop;
  if v_rows = '' then
    v_rows := '<tr><td colspan="2">Aucune heure comptabilisée.</td></tr>';
    v_text := v_text || E'Aucune heure comptabilisée.\n';
  end if;
  v_total := replace(to_char((v_snapshot->>'total_hours')::numeric, 'FM999999999990.00'), '.', ',');
  v_text := v_text || format(E'\nTotal : %s h\n\n', v_total)
    || 'Ces heures reprennent les bilans existants au moment du retrait : horaires prévus des interventions faites ou validées. '
    || 'Seul l’affichage dans la liste est supprimé. Les données et les anciens bilans sont conservés.';
  v_html := '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head><body>'
    || '<h2>Récapitulatif des heures</h2><p>' || private.html_escape(v_label || ' : ' || (v_snapshot->>'name')) || '</p>'
    || '<p>Retrait de la liste le ' || to_char(now() at time zone 'Indian/Reunion', 'DD/MM/YYYY à HH24:MI') || ' (La Réunion).</p>'
    || '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse"><thead><tr><th>Mois</th><th>Heures</th></tr></thead><tbody>'
    || v_rows || '</tbody><tfoot><tr><th>Total</th><th>' || v_total || ' h</th></tr></tfoot></table>'
    || '<p>Ces heures reprennent les bilans existants au moment du retrait : horaires prévus des interventions faites ou validées.</p>'
    || '<p>Seul l’affichage dans la liste est supprimé. Les données et les anciens bilans sont conservés.</p></body></html>';

  v_api_key := private.ahasend_api_key();
  if coalesce(v_api_key, '') = '' then
    raise exception 'Envoi du récapitulatif impossible : service email non configuré. Aucun retrait effectué.';
  end if;
  -- pg_net sends only after COMMIT; a rolled-back hide cannot send an email.
  v_request_id := net.http_post(
    'https://api.ahasend.com/v1/email/send',
    jsonb_build_object(
      'from', jsonb_build_object('email', 'info@avs-admin.re', 'name', 'AVS - Récapitulatif heures'),
      'recipients', jsonb_build_array(jsonb_build_object('email', v_recipient, 'name', 'Administrateur AVS')),
      'content', jsonb_build_object('subject', v_subject, 'text_body', v_text, 'html_body', v_html)
    ),
    '{}'::jsonb,
    jsonb_build_object('X-Api-Key', v_api_key, 'Content-Type', 'application/json'),
    10000
  );
  insert into private.admin_removal_email_notifications(entity_type, entity_id, snapshot, recipient, request_id)
  values(v_entity_type, new.id, v_snapshot, v_recipient, v_request_id);
  return new;
end;
$$;
revoke all on function private.email_hours_on_admin_list_removal() from public, anon, authenticated;

create trigger clients_email_hours_on_admin_list_removal
after update of hidden_from_admin_list on public.clients
for each row when (not old.hidden_from_admin_list and new.hidden_from_admin_list)
execute function private.email_hours_on_admin_list_removal();

create trigger employees_email_hours_on_admin_list_removal
after update of hidden_from_admin_list on public.employees
for each row when (not old.hidden_from_admin_list and new.hidden_from_admin_list)
execute function private.email_hours_on_admin_list_removal();
