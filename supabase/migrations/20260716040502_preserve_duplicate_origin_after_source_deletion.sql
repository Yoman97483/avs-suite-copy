-- This UUID is provenance, not a live ownership relationship. Keeping it after
-- the source is deleted lets the duplicate remain identifiable and protected.
alter table public.interventions
  drop constraint if exists interventions_duplicated_from_intervention_id_fkey;

comment on column public.interventions.duplicated_from_intervention_id is
  'Permanent identifier of the intervention copied by weekly duplication; the source may later be deleted.';

-- A deletion marker must also remain insertable after its source disappeared,
-- otherwise the administrator could no longer delete the surviving duplicate.
alter table public.intervention_duplication_skips
  drop constraint if exists intervention_duplication_skips_source_intervention_id_fkey;

comment on column public.intervention_duplication_skips.source_intervention_id is
  'Historical source identifier; it may reference an intervention that has since been deleted.';
