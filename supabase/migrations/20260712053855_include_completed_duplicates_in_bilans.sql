do $$
declare
  view_name text;
  view_definition text;
begin
  foreach view_name in array array[
    'employee_daily_trips',
    'employee_month_summary',
    'client_monthly_bilan'
  ]
  loop
    view_definition := pg_get_viewdef(
      format('public.%I', view_name)::regclass,
      true
    );

    view_definition := replace(
      view_definition,
      'i.duplicated_from_intervention_id IS NULL AND ',
      ''
    );

    execute format(
      'create or replace view public.%I with (security_invoker = true) as %s',
      view_name,
      view_definition
    );
  end loop;
end
$$;

notify pgrst, 'reload schema';
