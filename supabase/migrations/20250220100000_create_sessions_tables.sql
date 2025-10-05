-- Sessions tracking schema

create extension if not exists "pgcrypto";

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references public.plans(id) on delete set null,
  plan_name text,
  day_index smallint not null default 1,
  week_index smallint not null default 1,
  mode text not null default 'focus',
  status text not null default 'in-progress',
  started_at timestamptz not null default timezone('utc', now()),
  ended_at timestamptz,
  duration_seconds integer,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint sessions_day_check check (day_index between 1 and 7),
  constraint sessions_mode_check check (mode in ('focus', 'circuit')),
  constraint sessions_status_check check (status in ('in-progress', 'completed', 'aborted'))
);

create table if not exists public.session_workouts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workout_id bigint references public.workouts(id) on delete set null,
  workout_name text not null,
  position integer,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.session_sets (
  id uuid primary key default gen_random_uuid(),
  session_workout_id uuid not null references public.session_workouts(id) on delete cascade,
  exercise_id bigint references public.exercises(id) on delete set null,
  exercise_name text,
  day_index smallint,
  target_sets smallint,
  target_reps smallint,
  set_number smallint not null default 1,
  actual_reps smallint,
  completed boolean not null default false,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists sessions_plan_id_idx on public.sessions(plan_id);
create index if not exists sessions_status_idx on public.sessions(status);
create index if not exists session_workouts_session_id_idx on public.session_workouts(session_id);
create index if not exists session_sets_session_workout_id_idx on public.session_sets(session_workout_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_sessions'
  ) then
    create trigger set_updated_at_sessions
    before update on public.sessions
    for each row execute procedure public.set_updated_at();
  end if;
end;
$$;
