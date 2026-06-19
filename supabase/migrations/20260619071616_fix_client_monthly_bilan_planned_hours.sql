drop view if exists public.client_month_summary;
drop view if exists public.client_monthly_bilan;

create or replace view public.client_monthly_bilan
with (security_invoker = true)
as
with completed_interventions as (
  select
    ipa.client_id,
    ipa.client_name,
    date_trunc('month', ipa.date)::date as month_date,
    extract(year from ipa.date)::int as year,
    extract(month from ipa.date)::int as month_number,
    greatest(
      0,
      extract(epoch from (ipa.end_time_planned - ipa.start_time_planned)) / 3600.0
    )::numeric as planned_hours
  from public.interventions_progress_admin ipa
  where ipa.fait <> 'en attente'
)
select
  ci.client_id,
  ci.client_name,
  to_char(ci.month_date, 'TMMonth') as month,
  ci.year,
  ci.month_number,
  sum(ci.planned_hours) as hours_worked
from completed_interventions ci
group by
  ci.client_id,
  ci.client_name,
  ci.month_date,
  ci.year,
  ci.month_number;

create or replace view public.client_month_summary
with (security_invoker = true)
as
select * from public.client_monthly_bilan;

grant select on public.client_monthly_bilan to authenticated;
grant select on public.client_month_summary to authenticated;
revoke all on public.client_monthly_bilan from anon;
revoke all on public.client_month_summary from anon;

notify pgrst, 'reload schema';
