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
    and ipa.fait <> 'en attente'
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

grant select on public.missing_client_distances to authenticated;
revoke all on public.missing_client_distances from anon;

notify pgrst, 'reload schema';
