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
    },
  })
);

app.set('views', viewsPath);
app.set('view engine', 'hbs');

const supabaseClient = createSupabaseClient();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const workoutsRouter = require('./routes/workouts')(supabaseClient);
app.use('/workouts', workoutsRouter);

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
  });
});

app.use((_req, res) => {
  res.status(404).render('404', {
    layout: 'main',
    pageTitle: 'Not found',
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
