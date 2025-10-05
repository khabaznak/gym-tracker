alter table public.sessions enable row level security;
alter table public.session_workouts enable row level security;
alter table public.session_sets enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_select_policy'
  ) then
    create policy sessions_select_policy on public.sessions for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_insert_policy'
  ) then
    create policy sessions_insert_policy on public.sessions for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_update_policy'
  ) then
    create policy sessions_update_policy on public.sessions for update to anon using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_delete_policy'
  ) then
    create policy sessions_delete_policy on public.sessions for delete to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_workouts' and policyname = 'session_workouts_select_policy'
  ) then
    create policy session_workouts_select_policy on public.session_workouts for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_workouts' and policyname = 'session_workouts_insert_policy'
  ) then
    create policy session_workouts_insert_policy on public.session_workouts for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_workouts' and policyname = 'session_workouts_update_policy'
  ) then
    create policy session_workouts_update_policy on public.session_workouts for update to anon using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_workouts' and policyname = 'session_workouts_delete_policy'
  ) then
    create policy session_workouts_delete_policy on public.session_workouts for delete to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_sets' and policyname = 'session_sets_select_policy'
  ) then
    create policy session_sets_select_policy on public.session_sets for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_sets' and policyname = 'session_sets_insert_policy'
  ) then
    create policy session_sets_insert_policy on public.session_sets for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_sets' and policyname = 'session_sets_update_policy'
  ) then
    create policy session_sets_update_policy on public.session_sets for update to anon using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'session_sets' and policyname = 'session_sets_delete_policy'
  ) then
    create policy session_sets_delete_policy on public.session_sets for delete to anon using (true);
  end if;
end;
$$;
