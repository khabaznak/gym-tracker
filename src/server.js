const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const { engine } = require('express-handlebars');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

typeCheckEnv();

const app = express();
const port = process.env.PORT || 3000;

const viewsPath = path.join(__dirname, 'views');

app.engine(
  'hbs',
  engine({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: path.join(viewsPath, 'layouts'),
    partialsDir: path.join(viewsPath, 'partials'),
    helpers: {
      formatDate(value) {
        if (!value) {
          return 'Unknown date';
        }

        try {
          return new Intl.DateTimeFormat('en', {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(value));
        } catch (_err) {
          return 'Unknown date';
        }
      },
      eq(left, right) {
        return left === right;
      },
      includes(collection, value) {
        if (!Array.isArray(collection)) {
          return false;
        }

        const needle = String(value);
        return collection.some((item) => String(item) === needle);
      },
      toDateTimeLocal(value) {
        if (!value) {
          return '';
        }

        try {
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) {
            return '';
          }

          const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
          return offsetDate.toISOString().slice(0, 16);
        } catch (_error) {
          return '';
        }
      },
      dayName(index) {
        const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const numeric = Number.parseInt(index, 10);
        if (!Number.isFinite(numeric) || numeric < 1 || numeric > names.length) {
          return 'Day';
        }

        return names[numeric - 1];
      },
      capitalize(value) {
        if (typeof value !== 'string' || !value.length) {
          return '';
        }

        return value[0].toUpperCase() + value.slice(1);
      },
      json(value) {
        try {
          return JSON.stringify(value === undefined ? null : value);
        } catch (_error) {
          return 'null';
        }
      },
    },
  })
);

app.set('views', viewsPath);
app.set('view engine', 'hbs');

const supabaseClient = createSupabaseClient();

app.use((req, _res, next) => {
  if (!req.originalMethod) {
    req.originalMethod = req.method;
  }

  const hxMethod = req.get('Hx-Method');
  if (hxMethod) {
    req.method = hxMethod.toUpperCase();
  }

  const override = req.get('X-HTTP-Method-Override');
  if (!hxMethod && override) {
    req.method = override.toUpperCase();
  }

  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const workoutsModule = require('./routes/workouts');
const plansModule = require('./routes/plans');
const sessionsModule = require('./routes/sessions');
const workoutsRouter = workoutsModule.createRouter(supabaseClient);
const plansRouter = plansModule.createRouter(supabaseClient);
const sessionsRouter = sessionsModule.createRouter(supabaseClient);
const exercisesRouter = require('./routes/exercises')(supabaseClient);

const PLAN_PERIOD_WEEKS = {
  weekly: 1,
  'bi-weekly': 2,
  monthly: 4,
};

app.use('/workouts', workoutsRouter);
app.use('/plans', plansRouter);
app.use('/sessions', sessionsRouter);
app.use('/exercises', exercisesRouter);

app.get('/', async (_req, res) => {
  const supabaseReady = Boolean(supabaseClient);
  const today = new Date();
  const { start: weekStart, end: weekEnd } = getIsoWeekBounds(today);

  let activePlan = null;
  let planWeekIndex = 1;
  let weeklySchedule = null;
  let weeklyAssignments = [];
  let planError = null;

  if (supabaseClient) {
    const { plan: fetchedPlan, error: activePlanError } = await plansModule.fetchActivePlan(supabaseClient);

    if (activePlanError) {
      console.error('Failed to load active plan for dashboard', activePlanError);
      planError = 'Unable to load active plan details.';
    } else if (fetchedPlan) {
      activePlan = fetchedPlan;
      planWeekIndex = determinePlanWeek(activePlan, today);

      if (activePlan.schedule && Array.isArray(activePlan.schedule.weeks)) {
        const targetWeek = activePlan.schedule.weeks.find((week) => week.number === planWeekIndex)
          || activePlan.schedule.weeks[0];

        if (targetWeek) {
          weeklySchedule = targetWeek;
          weeklyAssignments = (targetWeek.days || []).map((day) => ({
            day_index: day.day_index,
            day_name: day.day_name,
            workouts: Array.isArray(day.workouts) ? day.workouts : [],
          }));
        }
      }
    } else {
      const { plans: fallbackPlans, error: plansError } = await plansModule.fetchPlans(supabaseClient, { limit: 10 });
      if (plansError) {
        console.error('Failed to load plans for dashboard fallback', plansError);
      } else if (Array.isArray(fallbackPlans) && fallbackPlans.length) {
        const candidate = fallbackPlans.find((plan) => plan && plan.status === 'active');
        if (candidate) {
          activePlan = candidate;
          planWeekIndex = determinePlanWeek(activePlan, today);

          if (activePlan.schedule && Array.isArray(activePlan.schedule.weeks)) {
            const targetWeek = activePlan.schedule.weeks.find((week) => week.number === planWeekIndex)
              || activePlan.schedule.weeks[0];

            if (targetWeek) {
              weeklySchedule = targetWeek;
              weeklyAssignments = (targetWeek.days || []).map((day) => ({
                day_index: day.day_index,
                day_name: day.day_name,
                workouts: Array.isArray(day.workouts) ? day.workouts : [],
              }));
            }
          }
        }
      }
    }
  }

  const weeklySessionsResult = await fetchSessionsForRange(supabaseClient, weekStart, weekEnd);
  if (weeklySessionsResult.error) {
    console.error('Failed to load sessions for dashboard', weeklySessionsResult.error);
  }
  const weeklySessions = weeklySessionsResult.sessions;

  const sessionsByDay = new Map();
  weeklySessions.forEach((session) => {
    const dayIndex = clampDay(session.day_index || getIsoDayNumber(new Date(session.started_at)));
    if (!sessionsByDay.has(dayIndex)) {
      sessionsByDay.set(dayIndex, []);
    }
    sessionsByDay.get(dayIndex).push(session);
  });

  const dayHeaders = activePlan && activePlan.schedule && Array.isArray(activePlan.schedule.dayHeaders)
    ? activePlan.schedule.dayHeaders
    : [
        { key: 'mon', label: 'Monday' },
        { key: 'tue', label: 'Tuesday' },
        { key: 'wed', label: 'Wednesday' },
        { key: 'thu', label: 'Thursday' },
        { key: 'fri', label: 'Friday' },
        { key: 'sat', label: 'Saturday' },
        { key: 'sun', label: 'Sunday' },
      ];

  const weeklyDays = dayHeaders.map((header, index) => {
    const dayIndex = index + 1;
    const assigned = weeklyAssignments.find((day) => Number(day.day_index) === dayIndex);
    const sessions = sessionsByDay.get(dayIndex) || [];

    let status = 'idle';
    if (sessions.some((session) => session.status === 'in-progress')) {
      status = 'in-progress';
    } else if (sessions.some((session) => session.status === 'completed')) {
      status = 'completed';
    }

    return {
      key: header.key,
      label: header.label,
      dayIndex,
      workouts: assigned ? assigned.workouts : [],
      sessions,
      status,
    };
  });

  const weeklySummary = {
    totalSessions: weeklySessions.length,
    completedSessions: weeklySessions.filter((session) => session.status === 'completed').length,
    inProgressSessions: weeklySessions.filter((session) => session.status === 'in-progress').length,
    totalDurationMinutes: weeklySessions.reduce((accumulator, session) => {
      if (Number.isFinite(session.duration_seconds)) {
        return accumulator + Math.round(session.duration_seconds / 60);
      }
      return accumulator;
    }, 0),
  };

  const recentSessions = weeklySessions
    .slice()
    .sort((left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime())
    .slice(0, 5);

  const dateFormatter = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  });

  const weekRangeLabel = `${dateFormatter.format(weekStart)} – ${dateFormatter.format(weekEnd)}`;

  res.render('home', {
    pageTitle: 'Dashboard',
    supabaseReady,
    activeNav: 'dashboard',
    activePlan,
    planWeekIndex,
    weeklyDays,
    weeklySummary,
    planError,
    weekStart,
    weekEnd,
    weekRangeLabel,
    recentSessions,
  });
});

app.get('/setup/exercises', async (_req, res) => {
  const supabaseReady = Boolean(supabaseClient);
  let exercises = [];

  if (supabaseClient) {
    const result = await fetchExercises(supabaseClient);

    if (result.error) {
      console.error('Failed to load exercises for setup view', result.error);
    } else {
      exercises = result.exercises;
    }
  }

  res.render('setup/exercises', {
    pageTitle: 'Manage Exercises',
    supabaseReady,
    exercises,
    activeNav: 'setup-exercises',
  });
});

app.get('/setup/workouts', async (_req, res) => {
  const supabaseReady = Boolean(supabaseClient);
  let workouts = [];
  let exercises = [];

  if (supabaseClient) {
    const [{ workouts: hydratedWorkouts, error: workoutsError }, { exercises: exerciseOptions, error: exercisesError }]
      = await Promise.all([
        workoutsModule.fetchWorkouts(supabaseClient, { limit: 50 }),
        workoutsModule.fetchExercisesForSelection(supabaseClient),
      ]);

    if (workoutsError) {
      console.error('Failed to load workouts for setup view', workoutsError);
    } else {
      workouts = hydratedWorkouts;
    }

    if (exercisesError) {
      console.error('Failed to load exercises for workout form', exercisesError);
    } else {
      exercises = exerciseOptions;
    }
  }

  res.render('setup/workouts', {
    pageTitle: 'Manage Workouts',
    supabaseReady,
    workouts,
    exercises,
    activeNav: 'setup-workouts',
  });
});

app.get('/setup/plans', async (_req, res) => {
  const isMissingRelationError = (error) => {
    if (!error) {
      return false;
    }

    if (error.code === '42P01') {
      return true;
    }

    const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
    return message.includes('does not exist');
  };

  let supabaseReady = Boolean(supabaseClient);
  let plans = [];
  let workouts = [];
  let planSchemaError = null;

  if (supabaseClient) {
    const [{ plans: planList, error: plansError }, { workouts: workoutOptions, error: workoutsError }]
      = await Promise.all([
        plansModule.fetchPlans(supabaseClient, { limit: 50 }),
        plansModule.fetchWorkoutsForSelection(supabaseClient),
      ]);

    const missingPlansTable = isMissingRelationError(plansError);
    const missingWorkoutsTable = isMissingRelationError(workoutsError);

    if (plansError) {
      const message = missingPlansTable
        ? 'Plans schema not found when loading setup view'
        : 'Failed to load plans for setup view';
      console[missingPlansTable ? 'warn' : 'error'](message, plansError);
    } else {
      plans = planList;
    }

    if (workoutsError) {
      const message = missingWorkoutsTable
        ? 'Workouts schema not found when loading plan form options'
        : 'Failed to load workouts for plan form';
      console[missingWorkoutsTable ? 'warn' : 'error'](message, workoutsError);
    } else {
      workouts = workoutOptions;
    }

    if (missingPlansTable || missingWorkoutsTable) {
      supabaseReady = false;
      const missingTables = [];
      if (missingPlansTable) {
        missingTables.push('plans');
      }
      if (missingWorkoutsTable) {
        missingTables.push('workouts');
      }

      planSchemaError = `Supabase schema for ${missingTables.join(' & ')} is missing. Run the plan migration in docs/manage-plans-checklist.md.`;
    }
  }

  const hasWorkouts = Array.isArray(workouts) && workouts.length > 0;
  const planSchemaMissing = Boolean(planSchemaError);

  res.render('setup/plans', {
    pageTitle: 'Manage Plans',
    supabaseReady,
    plans,
    workouts,
    activeNav: 'setup-plans',
    planSchemaError,
    hasWorkouts,
    planAssignmentsEnabled: supabaseReady && hasWorkouts,
    planSchemaMissing,
  });
});

app.get('/tracking/sessions', async (_req, res) => {
  const supabaseReady = Boolean(supabaseClient);
  const sessionDate = new Date();
  const sessionDateLabel = new Intl.DateTimeFormat('en', { dateStyle: 'full' }).format(sessionDate);
  const dayIndex = getIsoDayNumber(sessionDate);
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dayName = dayNames[(dayIndex - 1 + dayNames.length) % dayNames.length];

  const sessionState = {
    activePlan: null,
    workouts: [],
    weekIndex: 1,
    planError: null,
    workoutError: null,
  };

  if (supabaseClient) {
    const { plan: activePlan, error: activePlanError } = await plansModule.fetchActivePlan(supabaseClient);

    if (activePlanError) {
      console.error('Failed to load active plan for session tracker', activePlanError);
      sessionState.planError = 'Unable to load active plan. Verify your Supabase schema and try again.';
    } else if (activePlan) {
      sessionState.activePlan = activePlan;
      sessionState.weekIndex = determinePlanWeek(activePlan, sessionDate);

      const todaysAssignments = Array.isArray(activePlan.assignments)
        ? activePlan.assignments
            .filter((assignment) => {
              const assignmentWeek = Number.parseInt(assignment.week_index, 10);
              if (Number.isFinite(assignmentWeek) && assignmentWeek !== sessionState.weekIndex) {
                return false;
              }
              const assignmentDay = Number.parseInt(assignment.day_of_week, 10);
              return Number.isFinite(assignmentDay) ? assignmentDay === dayIndex : false;
            })
            .sort((left, right) => {
              const leftParsed = Number.parseInt(left.position, 10);
              const rightParsed = Number.parseInt(right.position, 10);
              const safeLeft = Number.isFinite(leftParsed) ? leftParsed : Number.MAX_SAFE_INTEGER;
              const safeRight = Number.isFinite(rightParsed) ? rightParsed : Number.MAX_SAFE_INTEGER;
              return safeLeft - safeRight;
            })
        : [];

      const workoutIds = Array.from(
        new Set(
          todaysAssignments
            .map((assignment) =>
              assignment.workout_id === undefined || assignment.workout_id === null
                ? ''
                : String(assignment.workout_id)
            )
            .filter((value) => value.length)
        )
      );

      let workoutLookup = new Map();

      if (workoutIds.length) {
        const { workouts: hydratedWorkouts, error: workoutsError } = await workoutsModule.fetchWorkoutsByIds(
          supabaseClient,
          workoutIds
        );

        if (workoutsError) {
          console.error('Failed to load workouts for session tracker', workoutsError);
          sessionState.workoutError = 'Workouts for today could not be loaded. Refresh after checking Supabase data.';
        } else if (Array.isArray(hydratedWorkouts) && hydratedWorkouts.length) {
          workoutLookup = new Map(
            hydratedWorkouts.map((workout) => [String(workout.id), workout])
          );
        }
      }

      sessionState.workouts = todaysAssignments
        .map((assignment) => {
          const key = assignment.workout_id === undefined || assignment.workout_id === null
            ? ''
            : String(assignment.workout_id);
          const hydrated = workoutLookup.get(key) || assignment.workout || null;
          if (!hydrated) {
            return null;
          }

          const exercises = Array.isArray(hydrated.exercises)
            ? hydrated.exercises.map((exercise, index) => buildExerciseSessionEntry(exercise, index))
            : [];

          return {
            id: hydrated.id || assignment.workout_id,
            name: hydrated.name || 'Workout',
            description: hydrated.description || null,
            rest_interval: hydrated.rest_interval || null,
            notes: hydrated.notes || null,
            position: (() => {
              const parsed = Number.parseInt(assignment.position, 10);
              return Number.isFinite(parsed) ? parsed : null;
            })(),
            exercises,
          };
        })
        .filter(Boolean);
    }
  }

  const hasSession = sessionState.workouts.length > 0;

  const sessionConfig = {
    planId: sessionState.activePlan ? sessionState.activePlan.id : null,
    planName: sessionState.activePlan ? sessionState.activePlan.name : null,
    dayIndex,
    weekIndex: sessionState.weekIndex,
    workouts: sessionState.workouts.map((workout) => ({
      id: workout.id,
      name: workout.name,
      exercises: workout.exercises.map((exercise) => ({
        id: exercise.id,
        name: exercise.name,
        targetSets: exercise.target_sets,
        targetReps: exercise.target_reps,
      })),
    })),
  };

  res.render('tracking/sessions', {
    pageTitle: 'Session Tracker',
    supabaseReady,
    activeNav: 'tracking-sessions',
    sessionDateLabel,
    dayName,
    dayIndex,
    planWeekIndex: sessionState.weekIndex,
    activePlan: sessionState.activePlan,
    sessionWorkouts: sessionState.workouts,
    hasSession,
    planError: sessionState.planError,
    workoutError: sessionState.workoutError,
    sessionConfig,
  });
});

app.get('/tracking/notes', (_req, res) => {
  const supabaseReady = Boolean(supabaseClient);

  res.render('tracking/notes', {
    pageTitle: 'Exercise Notes',
    supabaseReady,
    activeNav: 'tracking-notes',
  });
});

app.use((_req, res) => {
  res.status(404).render('404', {
    layout: 'main',
    pageTitle: 'Not found',
    activeNav: null,
  });
});

app.listen(port, () => {
  console.log(`🚀 Server ready at http://localhost:${port}`);
});

function typeCheckEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.warn(
      `⚠️ Missing environment variables: ${missing.join(', ')}. Supabase features will not work until they are set.`
    );
  }
}

function createSupabaseClient() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
    },
  });
}

async function fetchRecentWorkouts(supabase) {
  if (!supabase) {
    return { workouts: [], error: null };
  }

  const { data, error } = await supabase
    .from('workouts')
    .select('*')
    .order('performed_at', { ascending: false })
    .limit(20);

  return { workouts: data || [], error };
}

async function fetchExercises(supabase) {
  if (!supabase) {
    return { exercises: [], error: null };
  }

  const { data, error } = await supabase
    .from('exercises')
    .select('*')
    .order('name', { ascending: true })
    .limit(100);

  return { exercises: data || [], error };
}

async function fetchSessionsForRange(supabase, start, end) {
  if (!supabase || !start || !end) {
    return { sessions: [], error: null };
  }

  const { data, error } = await supabase
    .from('sessions')
    .select('id, plan_id, plan_name, status, mode, day_index, week_index, started_at, ended_at, duration_seconds')
    .gte('started_at', start.toISOString())
    .lte('started_at', end.toISOString())
    .order('started_at', { ascending: true });

  const sessions = Array.isArray(data)
    ? data.map((session) => ({
        ...session,
        duration_minutes: Number.isFinite(session.duration_seconds)
          ? Math.round(session.duration_seconds / 60)
          : null,
      }))
    : [];

  return { sessions, error };
}

function determinePlanWeek(plan, referenceDate = new Date()) {
  if (!plan) {
    return 1;
  }

  const period = typeof plan.period === 'string' ? plan.period : 'weekly';
  const maxWeeks = PLAN_PERIOD_WEEKS[period] || 1;

  const createdAt = plan && plan.created_at ? new Date(plan.created_at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !Number.isFinite(maxWeeks) || maxWeeks <= 0) {
    return 1;
  }

  const diffMs = referenceDate.getTime() - createdAt.getTime();
  const diffDays = Math.max(Math.floor(diffMs / 86_400_000), 0);
  const weeksElapsed = Math.floor(diffDays / 7);

  return (weeksElapsed % maxWeeks) + 1;
}

function getIsoDayNumber(date = new Date()) {
  const jsDay = date.getDay();
  return ((jsDay + 6) % 7) + 1;
}

function getIsoWeekBounds(date = new Date()) {
  const input = new Date(date);
  input.setHours(0, 0, 0, 0);
  const dayIndex = getIsoDayNumber(input);

  const start = new Date(input);
  start.setDate(input.getDate() - (dayIndex - 1));
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function clampDay(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return 1;
  }

  if (numeric < 1) {
    return 1;
  }

  if (numeric > 7) {
    return 7;
  }

  return numeric;
}

function buildExerciseSessionEntry(exercise, index = 0) {
  const toPositiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  };

  const fallbackPosition = index + 1;
  const targetSets = toPositiveInteger(exercise && exercise.target_sets, 3);
  const targetReps = toPositiveInteger(exercise && exercise.target_reps, 10);

  const sets = Array.from({ length: targetSets }, (_, setIndex) => ({
    index: setIndex + 1,
    target_reps: targetReps,
  }));

  const parsedPosition = Number.parseInt(exercise && exercise.position, 10);
  const position = Number.isFinite(parsedPosition) && parsedPosition > 0 ? parsedPosition : fallbackPosition;

  return {
    id: exercise && exercise.id ? exercise.id : `exercise-${fallbackPosition}`,
    name: exercise && exercise.name ? exercise.name : 'Exercise',
    category: exercise && exercise.category ? exercise.category : null,
    target_muscle: exercise && exercise.target_muscle ? exercise.target_muscle : null,
    primary_muscle: exercise && exercise.primary_muscle ? exercise.primary_muscle : null,
    target_sets: targetSets,
    target_reps: targetReps,
    notes: exercise && typeof exercise.notes === 'string' && exercise.notes.trim().length
      ? exercise.notes.trim()
      : null,
    position,
    sets,
  };
}
