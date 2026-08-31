-- All changes and pg_net requests are rolled back: no employee/client is hidden,
-- and no test email is sent. Run as postgres in avs-copy only.
begin;
set local statement_timeout = '90s';

do $$
declare
  v_id uuid;
  v_kind text;
  v_snapshot jsonb;
  v_expected jsonb;
  v_total numeric;
  v_before bigint;
  v_after bigint;
  v_client uuid;
  v_employee uuid;
  v_payload jsonb;
  v_notification private.admin_removal_email_notifications%rowtype;
begin
  -- Compare the snapshot for every existing client and employee with the views
  -- used in their respective hour reports, including zero-hour histories.
  for v_id, v_kind in
    select id, 'client' from public.clients
    union all select id, 'employee' from public.employees
  loop
    v_snapshot := private.admin_removal_hours_snapshot(v_kind, v_id);
    if v_kind = 'client' then
      select coalesce(jsonb_agg(jsonb_build_object('month', make_date(year, month_number, 1), 'hours', round(hours_worked, 2)) order by year, month_number), '[]'),
        coalesce(sum(round(hours_worked, 2)), 0)
      into v_expected, v_total from public.client_monthly_bilan where client_id = v_id;
    else
      select coalesce(jsonb_agg(jsonb_build_object('month', month, 'hours', round(hours_worked, 2)) order by month), '[]'),
        coalesce(sum(round(hours_worked, 2)), 0)
      into v_expected, v_total from public.employee_month_summary where employee_id = v_id;
    end if;
    if v_snapshot->'months' is distinct from v_expected or (v_snapshot->>'total_hours')::numeric is distinct from v_total then
      raise exception 'Snapshot does not match the % report', v_kind;
    end if;
  end loop;

  select id into strict v_client from public.clients where not hidden_from_admin_list order by id limit 1;
  select id into strict v_employee from public.employees where not hidden_from_admin_list order by id limit 1;
  select count(*) into v_before from private.admin_removal_email_notifications;

  update public.clients set name = 'Test <client> & "nom"' where id = v_client;
  update public.clients set hidden_from_admin_list = true where id = v_client;
  update public.employees set hidden_from_admin_list = true where id = v_employee;
  select count(*) into v_after from private.admin_removal_email_notifications;
  if v_after <> v_before + 2 then raise exception 'Expected one notification per hidden entity'; end if;

  for v_notification in select * from private.admin_removal_email_notifications
    where entity_id in (v_client, v_employee) and created_at = transaction_timestamp()
    order by created_at, id
  loop
    select convert_from(body, 'UTF8')::jsonb into v_payload from net.http_request_queue where id = v_notification.request_id;
    if v_payload is null then raise exception 'Email was not queued'; end if;
    if v_payload->'recipients' <> '[{"email":"avs.run974@gmail.com","name":"Administrateur AVS"}]'::jsonb then
      raise exception 'Unexpected email recipients';
    end if;
    if v_notification.snapshot <> private.admin_removal_hours_snapshot(v_notification.entity_type, v_notification.entity_id) then
      raise exception 'Wrong report stored with email request';
    end if;
    if position('Total :' in v_payload #>> '{content,text_body}') = 0
      or position('horaires prévus' in v_payload #>> '{content,text_body}') = 0 then
      raise exception 'Missing report total or accounting explanation';
    end if;
    if v_notification.entity_type = 'client' and (
      position('Test &lt;client&gt; &amp; &quot;nom&quot;' in v_payload #>> '{content,html_body}') = 0
      or position('<client>' in v_payload #>> '{content,html_body}') > 0
    ) then raise exception 'Client name is not escaped'; end if;
  end loop;

  update public.clients set hidden_from_admin_list = true where id = v_client;
  update public.employees set hidden_from_admin_list = true where id = v_employee;
  update public.clients set hidden_from_admin_list = false where id = v_client;
  update public.employees set hidden_from_admin_list = false where id = v_employee;
  select count(*) into v_after from private.admin_removal_email_notifications;
  if v_after <> v_before + 2 then raise exception 'Repeat update or restoration sent another email'; end if;

  if has_table_privilege('authenticated', 'private.admin_removal_email_notifications', 'SELECT')
    or has_function_privilege('authenticated', 'private.admin_removal_hours_snapshot(text,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'private.email_hours_on_admin_list_removal()', 'EXECUTE') then
    raise exception 'Private report functions or ledger are exposed';
  end if;
end $$;
rollback;
select 'PASS: all monthly snapshots and totals match reports; one email per visual removal; safe HTML; repeat updates do not resend; private permissions checked; no test changes or emails committed' as result;
