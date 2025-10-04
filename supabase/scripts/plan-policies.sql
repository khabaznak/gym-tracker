alter table public.plans enable row level security;
alter table public.plan_workouts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plans' and policyname = 'plans_select_policy'
  ) then
    create policy plans_select_policy on public.plans
      for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plan_workouts' and policyname = 'plan_workouts_select_policy'
  ) then
    create policy plan_workouts_select_policy on public.plan_workouts
      for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plans' and policyname = 'plans_insert_policy'
  ) then
    create policy plans_insert_policy on public.plans
      for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plan_workouts' and policyname = 'plan_workouts_insert_policy'
  ) then
    create policy plan_workouts_insert_policy on public.plan_workouts
      for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plans' and policyname = 'plans_update_policy'
  ) then
    create policy plans_update_policy on public.plans
      for update to anon using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plan_workouts' and policyname = 'plan_workouts_update_policy'
  ) then
    create policy plan_workouts_update_policy on public.plan_workouts
      for update to anon using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plans' and policyname = 'plans_delete_policy'
  ) then
    create policy plans_delete_policy on public.plans
      for delete to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plan_workouts' and policyname = 'plan_workouts_delete_policy'
  ) then
    create policy plan_workouts_delete_policy on public.plan_workouts
      for delete to anon using (true);
  end if;
end;
$$;
