alter table public.employees
  add column hidden_from_admin_list boolean not null default false;

alter table public.clients
  add column hidden_from_admin_list boolean not null default false;

comment on column public.employees.hidden_from_admin_list is
  'UI-only visibility in the Employees tab. Does not disable Auth or hide planning/history.';
comment on column public.clients.hidden_from_admin_list is
  'UI-only visibility in the Clients tab. Does not hide planning/history or client selectors.';
