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
const workoutsRouter = workoutsModule.createRouter(supabaseClient);
const plansRouter = plansModule.createRouter(supabaseClient);
const exercisesRouter = require('./routes/exercises')(supabaseClient);

app.use('/workouts', workoutsRouter);
app.use('/plans', plansRouter);
app.use('/exercises', exercisesRouter);

app.get('/', async (_req, res) => {
  const supabaseReady = Boolean(supabaseClient);
  const { workouts, error } = await fetchRecentWorkouts(supabaseClient);

  if (error) {
    console.error('Failed to prefetch workouts for home view', error);
  }

  res.render('home', {
    pageTitle: 'Home',
    supabaseReady,
    workouts,
    activeNav: 'dashboard',
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

app.get('/tracking/sessions', (_req, res) => {
  const supabaseReady = Boolean(supabaseClient);

  res.render('tracking/sessions', {
    pageTitle: 'Session Tracker',
    supabaseReady,
    activeNav: 'tracking-sessions',
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
