do $$
declare
  view_definition text;
begin
  view_definition := pg_get_viewdef(
    'public.employee_month_summary'::regclass,
    true
  );

  view_definition := regexp_replace(
    view_definition,
    '[[:alnum:]_]+[.]duplicated_from_intervention_id IS NULL AND ',
    '',
    'g'
  );

  execute
    'create or replace view public.employee_month_summary '
    || 'with (security_invoker = true) as '
    || view_definition;
end
$$;

notify pgrst, 'reload schema';
