-- Plans and scheduling tables

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  period text not null default 'weekly',
  status text not null default 'inactive',
  label text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.plan_workouts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  workout_id uuid not null references public.workouts(id) on delete cascade,
  week_index integer not null default 1,
  day_of_week integer not null default 1,
  position integer not null default 1,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists plan_workouts_plan_id_idx on public.plan_workouts(plan_id);
create index if not exists plan_workouts_workout_id_idx on public.plan_workouts(workout_id);

-- Unique scheduling per plan/day/workout (allows multiple workouts per day via position)
create unique index if not exists plan_workouts_plan_day_position_key
  on public.plan_workouts(plan_id, week_index, day_of_week, position);

-- Ensure week/day are positive
alter table public.plan_workouts
  add constraint plan_workouts_week_positive_check check (week_index >= 1);

alter table public.plan_workouts
  add constraint plan_workouts_day_range_check check (day_of_week between 1 and 7);

-- Ensure period/status values stay within expected options
alter table public.plans
  add constraint plans_period_check
  check (period in ('weekly', 'bi-weekly', 'monthly'));

alter table public.plans
  add constraint plans_status_check
  check (status in ('active', 'inactive'));

-- Trigger to maintain updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at_plans
before update on public.plans
for each row execute procedure public.set_updated_at();
