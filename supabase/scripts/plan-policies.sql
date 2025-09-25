alter table public.plans enable row level security;
alter table public.plan_workouts enable row level security;

create policy if not exists plans_select_policy on public.plans
  for select to anon using (true);
create policy if not exists plan_workouts_select_policy on public.plan_workouts
  for select to anon using (true);

create policy if not exists plans_insert_policy on public.plans
  for insert to anon with check (true);
create policy if not exists plan_workouts_insert_policy on public.plan_workouts
  for insert to anon with check (true);

create policy if not exists plans_update_policy on public.plans
  for update to anon using (true) with check (true);
create policy if not exists plan_workouts_update_policy on public.plan_workouts
  for update to anon using (true) with check (true);

create policy if not exists plans_delete_policy on public.plans
  for delete to anon using (true);
create policy if not exists plan_workouts_delete_policy on public.plan_workouts
  for delete to anon using (true);
