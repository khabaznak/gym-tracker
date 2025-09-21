const express = require('express');

function createRouter(supabase) {
  const router = express.Router();

  router.use((req, _res, next) => {
    if (req.method === 'POST') {
      const hxMethod = req.get('Hx-Method');
      if (hxMethod) {
        req.method = hxMethod.toUpperCase();
      }

      const override = req.get('X-HTTP-Method-Override');
      if (!hxMethod && override) {
        req.method = override.toUpperCase();
      }
    }

    next();
  });

  router.get('/fragment', async (req, res) => {
    if (!supabase) {
      return res.render('workouts/list-fragment', {
        layout: false,
        workouts: [],
        supabaseReady: false,
        manageable: req.query.mode === 'manage',
      });
    }

    const { workouts, error } = await fetchWorkouts(supabase);
    const manageable = req.query.mode === 'manage';

    if (error) {
      console.error('Failed to load workouts from Supabase', error);
      return renderHxError(res, 500, 'Unable to load workouts.');
    }

    return res.render('workouts/list-fragment', {
      layout: false,
      workouts,
      supabaseReady: true,
      manageable,
    });
  });

  router.get('/:id/fragment', async (req, res) => {
    if (!supabase) {
      return renderHxError(res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseWorkoutId(req.params.id);
    if (idError) {
      return renderHxError(res, 400, idError);
    }

    const { workout, error, status } = await fetchWorkoutById(supabase, id);

    if (error) {
      if (status === 406) {
        return renderHxError(res, 404, 'Workout not found');
      }

      console.error('Failed to load workout', error);
      return renderHxError(res, 500, 'Unable to load workout');
    }

    if (!workout) {
      return renderHxError(res, 404, 'Workout not found');
    }

    return res.render('workouts/item-fragment', {
      layout: false,
      workout,
      manageable: req.query.mode === 'manage',
    });
  });

  router.get('/:id/edit', async (req, res) => {
    if (!supabase) {
      return renderHxError(res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseWorkoutId(req.params.id);
    if (idError) {
      return renderHxError(res, 400, idError);
    }

    const [workoutResult, exercisesResult] = await Promise.all([
      fetchWorkoutById(supabase, id),
      fetchExercisesForSelection(supabase),
    ]);

    if (workoutResult.error) {
      if (workoutResult.status === 406) {
        return renderHxError(res, 404, 'Workout not found');
      }

      console.error('Failed to load workout for editing', workoutResult.error);
      return renderHxError(res, 500, 'Unable to load workout');
    }

    if (!workoutResult.workout) {
      return renderHxError(res, 404, 'Workout not found');
    }

    if (exercisesResult.error) {
      console.error('Failed to load exercises for selection', exercisesResult.error);
    }

    return res.render('workouts/edit-form', {
      layout: false,
      workout: workoutResult.workout,
      exercises: exercisesResult.exercises || [],
    });
  });

  router.get('/', async (_req, res) => {
    if (!supabase) {
      return res.status(200).json({ workouts: [], message: 'Supabase not configured' });
    }

    const { workouts, error } = await fetchWorkouts(supabase);

    if (error) {
      console.error('Failed to load workouts from Supabase', error);
      return res.status(500).json({ error: 'Unable to load workouts' });
    }

    return res.json({ workouts });
  });

  router.get('/:id', async (req, res) => {
    if (!supabase) {
      return res.status(200).json({ workout: null, message: 'Supabase not configured' });
    }

    const { id, error: idError } = parseWorkoutId(req.params.id);
    if (idError) {
      return res.status(400).json({ error: idError });
    }

    const { workout, error, status } = await fetchWorkoutById(supabase, id);

    if (error) {
      if (status === 406) {
        return res.status(404).json({ error: 'Workout not found' });
      }

      console.error('Failed to load workout', error);
      return res.status(500).json({ error: 'Unable to load workout' });
    }

    if (!workout) {
      return res.status(404).json({ error: 'Workout not found' });
    }

    return res.json({ workout });
  });

  router.post('/', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { payload, error } = buildWorkoutPayload(req.body);

    if (error) {
      return respond(req, res, 400, error);
    }

    const { data, error: insertError } = await supabase
      .from('workouts')
      .insert(payload)
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create workout', insertError);
      return respond(req, res, 500, 'Unable to create workout');
    }

    const { workout } = await hydrateWorkouts(supabase, [data]);
    const hydrated = workout || data;

    if (req.headers['hx-request']) {
      return res.status(201).render('workouts/create-response', {
        layout: false,
        workout: hydrated,
      });
    }

    return res.status(201).json({ workout: hydrated });
  });

  router.put('/:id', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseWorkoutId(req.params.id);
    if (idError) {
      return respond(req, res, 400, idError);
    }

    const { payload, error: validationError } = buildWorkoutPayload(req.body);

    if (validationError) {
      return respond(req, res, 400, validationError);
    }

    const { data: updatedRows, error: updateError, status: updateStatus } = await supabase
      .from('workouts')
      .update(payload)
      .eq('id', id)
      .select();

    if (updateError) {
      if (updateStatus === 406) {
        return respond(req, res, 404, 'Workout not found');
      }

      console.error('Failed to update workout', updateError);
      return respond(req, res, 500, 'Unable to update workout');
    }

    let workout = Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : null;

    if (!workout) {
      const {
        data: fetchedRows,
        error: fetchError,
        status: fetchStatus,
      } = await supabase
        .from('workouts')
        .select('*')
        .eq('id', id);

      if (fetchError) {
        if (fetchStatus === 406) {
          return respond(req, res, 404, 'Workout not found');
        }

        console.error('Failed to load updated workout', fetchError);
        return respond(req, res, 500, 'Unable to update workout');
      }

      if (Array.isArray(fetchedRows) && fetchedRows.length) {
        workout = fetchedRows[0];
      }

      if (!workout) {
        return respond(req, res, 404, 'Workout not found');
      }
    }

    const hydrated = (await hydrateWorkouts(supabase, [workout])).workout || workout;

    if (req.headers['hx-request']) {
      return res.render('workouts/update-response', {
        layout: false,
        workout: hydrated,
      });
    }

    return res.json({ workout: hydrated });
  });

  router.delete('/:id', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseWorkoutId(req.params.id);
    if (idError) {
      return respond(req, res, 400, idError);
    }

    const { error, status } = await supabase
      .from('workouts')
      .delete()
      .eq('id', id);

    if (error) {
      if (status === 406) {
        return respond(req, res, 404, 'Workout not found');
      }

      console.error('Failed to delete workout', error);
      return respond(req, res, 500, 'Unable to delete workout');
    }

    if (req.headers['hx-request']) {
      return res.send('');
    }

    return res.status(204).end();
  });

  return router;
}

module.exports = {
  createRouter,
  fetchWorkouts,
  fetchWorkoutById,
  fetchExercisesForSelection,
};

async function fetchWorkouts(supabase, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from('workouts')
    .select('*')
    .order('performed_at', { ascending: false, nullsLast: false })
    .limit(limit);

  if (error) {
    return { workouts: [], error };
  }

  const { workouts } = await hydrateWorkouts(supabase, data || []);
  return { workouts, error: null };
}

async function fetchWorkoutById(supabase, id) {
  const { data, error, status } = await supabase
    .from('workouts')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return { workout: null, error, status };
  }

  if (!data) {
    return { workout: null, error: null, status: 404 };
  }

  const { workouts } = await hydrateWorkouts(supabase, [data]);
  return { workout: workouts[0] || data, error: null, status: 200 };
}

async function fetchExercisesForSelection(supabase) {
  if (!supabase) {
    return { exercises: [], error: null };
  }

  const { data, error } = await supabase
    .from('exercises')
    .select('id, name, category, target_muscle, primary_muscle')
    .order('name', { ascending: true })
    .limit(200);

  return { exercises: data || [], error };
}

async function hydrateWorkouts(supabase, input) {
  const workouts = Array.isArray(input) ? [...input] : [];

  const idSet = new Set();
  const normalizedWorkouts = workouts.map((workout) => {
    const exerciseIds = normalizeExerciseIds(workout.exercise_ids);
    exerciseIds.forEach((value) => idSet.add(value));

    return {
      ...workout,
      exercise_ids: exerciseIds,
    };
  });

  let exerciseMap = new Map();

  if (idSet.size) {
    const queryIds = Array.from(idSet);
    const { data, error } = await supabase
      .from('exercises')
      .select('id, name, category, target_muscle, primary_muscle')
      .in('id', queryIds);

    if (error) {
      console.error('Failed to hydrate exercises for workouts', error);
    } else if (Array.isArray(data)) {
      exerciseMap = new Map(data.map((exercise) => [String(exercise.id), exercise]));
    }
  }

  normalizedWorkouts.forEach((workout) => {
    workout.exercises = workout.exercise_ids
      .map((exerciseId) => exerciseMap.get(String(exerciseId)))
      .filter(Boolean);
  });

  return { workouts: normalizedWorkouts, workout: normalizedWorkouts[0] };
}

function buildWorkoutPayload(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return { error: 'Workout name is required' };
  }

  const videoUrl = normalizeUrl(body.video_url);
  if (videoUrl === false) {
    return { error: 'Video link must be a valid URL starting with http or https.' };
  }

  const performedAtResult = toNullableDate(body.performed_at);
  if (performedAtResult === false) {
    return { error: 'Session date is invalid' };
  }

  const exerciseIds = normalizeExerciseIdsInput(body.exercise_ids);

  return {
    payload: {
      name,
      description: toNullableString(body.description),
      notes: toNullableString(body.notes),
      video_url: videoUrl,
      rest_interval: toNullableString(body.rest_interval),
      performed_at: performedAtResult || null,
      exercise_ids: exerciseIds.length ? exerciseIds : null,
    },
  };
}

function normalizeExerciseIds(exerciseIds) {
  if (!exerciseIds) {
    return [];
  }

  if (Array.isArray(exerciseIds)) {
    return exerciseIds.map((value) => String(value)).filter(Boolean);
  }

  if (typeof exerciseIds === 'string') {
    try {
      const parsed = JSON.parse(exerciseIds);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value)).filter(Boolean);
      }
    } catch (_err) {
      return exerciseIds.split(',').map((value) => value.trim()).filter(Boolean);
    }
  }

  return [];
}

function normalizeExerciseIdsInput(value) {
  if (value === undefined || value === null) {
    return [];
  }

  const list = Array.isArray(value) ? value : [value];
  const unique = new Set();

  list.forEach((entry) => {
    if (entry === undefined || entry === null) {
      return;
    }

    const trimmed = String(entry).trim();
    if (trimmed) {
      unique.add(trimmed);
    }
  });

  return Array.from(unique);
}

function parseWorkoutId(param = '') {
  const trimmed = String(param ?? '').trim();
  if (!trimmed) {
    return { error: 'Invalid workout id' };
  }

  const numeric = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(numeric) && String(numeric) === trimmed) {
    return { id: numeric };
  }

  return { id: trimmed };
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

function toNullableString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    return parsed.toString();
  } catch (_error) {
    return false;
  }
}

function toNullableDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.toISOString();
}
