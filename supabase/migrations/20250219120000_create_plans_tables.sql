-- Migration: create plans and plan_workouts tables plus supporting indexes and triggers
-- This mirrors the SQL in supabase/scripts/plan-schema.sql so the schema can
-- be applied via `supabase db push` or the Supabase migration workflow.

create extension if not exists "pgcrypto";

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
  workout_id bigint not null references public.workouts(id) on delete cascade,
  week_index integer not null default 1,
  day_of_week integer not null default 1,
  position integer not null default 1,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists plan_workouts_plan_id_idx on public.plan_workouts(plan_id);
create index if not exists plan_workouts_workout_id_idx on public.plan_workouts(workout_id);

create unique index if not exists plan_workouts_plan_day_position_key
  on public.plan_workouts(plan_id, week_index, day_of_week, position);

-- Ensure constraints exist without failing if they were added manually before.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'plan_workouts_week_positive_check'
      and conrelid = 'public.plan_workouts'::regclass
  ) then
    alter table public.plan_workouts
      add constraint plan_workouts_week_positive_check check (week_index >= 1);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'plan_workouts_day_range_check'
      and conrelid = 'public.plan_workouts'::regclass
  ) then
    alter table public.plan_workouts
      add constraint plan_workouts_day_range_check check (day_of_week between 1 and 7);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'plans_period_check'
      and conrelid = 'public.plans'::regclass
  ) then
    alter table public.plans
      add constraint plans_period_check
      check (period in ('weekly', 'bi-weekly', 'monthly'));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'plans_status_check'
      and conrelid = 'public.plans'::regclass
  ) then
    alter table public.plans
      add constraint plans_status_check
      check (status in ('active', 'inactive'));
  end if;
end;
$$;

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

-- Create the trigger only if it has not been registered yet.
do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'set_updated_at_plans'
      and tgrelid = 'public.plans'::regclass
  ) then
    create trigger set_updated_at_plans
    before update on public.plans
    for each row execute procedure public.set_updated_at();
  end if;
end;
$$;
