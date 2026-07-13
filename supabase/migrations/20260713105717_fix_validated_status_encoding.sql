do $$
declare
  view_definition text;
begin
  select pg_get_viewdef('public.interventions_progress_admin'::regclass, true)
  into view_definition;

  view_definition := replace(
    view_definition,
    quote_literal('valid' || chr(195) || chr(169)),
    'U&''valid\00E9'''
  );

  execute 'create or replace view public.interventions_progress_admin '
    || 'with (security_invoker = true) as '
    || view_definition;
end;
$$;
