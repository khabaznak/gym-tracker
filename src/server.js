const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

typeCheckEnv();

const app = express();
const port = process.env.PORT || 3000;

const supabaseClient = createSupabaseClient();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const workoutsRouter = require('./routes/workouts')(supabaseClient);
app.use('/workouts', workoutsRouter);

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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
