const express = require('express');

module.exports = (supabase) => {
  const router = express.Router();

  router.get('/fragment', async (_req, res) => {
    if (!supabase) {
      return res.render('workouts/list-fragment', {
        layout: false,
        workouts: [],
        supabaseReady: false,
      });
    }

    const { data, error } = await fetchWorkouts(supabase);

    if (error) {
      console.error('Failed to load workouts from Supabase', error);
      return renderHxError(res, 500, 'Unable to load workouts.');
    }

    return res.render('workouts/list-fragment', {
      layout: false,
      workouts: data,
      supabaseReady: true,
    });
  });

  router.get('/', async (_req, res) => {
    if (!supabase) {
      return res.status(200).json({ workouts: [], message: 'Supabase not configured' });
    }

    const { data, error } = await fetchWorkouts(supabase);

    if (error) {
      console.error('Failed to load workouts from Supabase', error);
      return res.status(500).json({ error: 'Unable to load workouts' });
    }

    return res.json({ workouts: data });
  });

  router.post('/', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { name, performed_at, notes } = req.body;

    if (!name || !performed_at) {
      return respond(req, res, 400, 'Workout name and performed_at are required');
    }

    const payload = {
      name,
      performed_at,
      notes: notes || null,
    };

    const { data, error } = await supabase.from('workouts').insert(payload).select().single();

    if (error) {
      console.error('Failed to create workout', error);
      return respond(req, res, 500, 'Unable to create workout');
    }

    if (req.headers['hx-request']) {
      return res.render('workouts/item-fragment', {
        layout: false,
        workout: data,
      });
    }

    return res.status(201).json({ workout: data });
  });

  return router;
};

async function fetchWorkouts(supabase) {
  return supabase
    .from('workouts')
    .select('*')
    .order('performed_at', { ascending: false })
    .limit(20);
}

function respond(req, res, status, message) {
  if (req.headers['hx-request']) {
    return renderHxError(res, status, message);
  }

  return res.status(status).json({ error: message });
}

function renderHxError(res, status, message) {
  return res.status(status).send(
    `<p class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-orange/40 dark:bg-orange/10 dark:text-orange">${escapeHtml(
      message
    )}</p>`
  );
}

function escapeHtml(string = '') {
  return string
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
