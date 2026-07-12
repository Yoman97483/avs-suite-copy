do $$
declare
  view_definition text;
begin
  view_definition := pg_get_viewdef('public.interventions_progress_admin'::regclass, true);
  view_definition := replace(
    view_definition,
    convert_from(decode('76616c6964c383c2a9', 'hex'), 'UTF8'),
    convert_from(decode('76616c6964c3a9', 'hex'), 'UTF8')
  );

  execute 'create or replace view public.interventions_progress_admin '
    || 'with (security_invoker = true) as '
    || view_definition;
end
$$;
