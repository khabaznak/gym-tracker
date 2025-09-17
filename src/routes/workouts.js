const express = require('express');

module.exports = (supabase) => {
  const router = express.Router();

  router.get('/fragment', async (_req, res) => {
    if (!supabase) {
      return res
        .status(200)
        .send('<p class="text-sm text-red-600 dark:text-orange">Supabase is not configured yet. Update your .env file.</p>');
    }

    const { data, error } = await supabase
      .from('workouts')
      .select('*')
      .order('performed_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Failed to load workouts from Supabase', error);
      return res
        .status(500)
        .send('<p class="text-sm text-red-600 dark:text-orange">Unable to load workouts.</p>');
    }

    return res.send(renderWorkoutList(data));
  });

  router.get('/', async (_req, res) => {
    if (!supabase) {
      return res.status(200).json({ workouts: [], message: 'Supabase not configured' });
    }

    const { data, error } = await supabase
      .from('workouts')
      .select('*')
      .order('performed_at', { ascending: false })
      .limit(20);

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

    const { data, error } = await supabase
      .from('workouts')
      .insert({ name, performed_at, notes: notes || null })
      .select()
      .single();

    if (error) {
      console.error('Failed to create workout', error);
      return respond(req, res, 500, 'Unable to create workout');
    }

    // When called over HTMX, return the newly rendered list item fragment.
    if (req.headers['hx-request']) {
      return res.send(renderWorkoutList([data]));
    }

    return res.status(201).json({ workout: data });
  });

  return router;
};

function respond(req, res, status, message) {
  if (req.headers['hx-request']) {
    return res.status(status).send(
      `<p class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-orange/40 dark:bg-orange/10 dark:text-orange">${escapeHtml(message)}</p>`
    );
  }

  return res.status(status).json({ error: message });
}

function renderWorkoutList(workouts = []) {
  if (!workouts.length) {
    return '<p class="text-sm text-graphite/70 dark:text-fog/70">No workouts logged yet.</p>';
  }

  return workouts
    .map((workout) => {
      const date = workout.performed_at
        ? new Date(workout.performed_at).toLocaleString()
        : 'Unknown date';

      return `
        <article class="flex flex-col gap-1 rounded-lg border border-graphite/15 bg-white p-4 shadow-sm transition hover:border-teal dark:border-fog/10 dark:bg-graphite dark:hover:border-orange">
          <div class="flex items-baseline justify-between">
            <h3 class="text-lg font-semibold text-ink dark:text-white">${escapeHtml(workout.name)}</h3>
            <time class="text-xs uppercase tracking-wide text-graphite/60 dark:text-fog/60">${date}</time>
          </div>
          ${workout.notes ? `<p class="text-sm text-graphite/80 dark:text-fog/70">${escapeHtml(workout.notes)}</p>` : ''}
        </article>
      `;
    })
    .join('\n');
}

function escapeHtml(string = '') {
  return string
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
