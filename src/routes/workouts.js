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

    const { payload, exerciseIds, error } = buildWorkoutPayload(req.body);

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

    const joinError = await replaceWorkoutExercises(supabase, data.id, exerciseIds, { skipDelete: true });

    if (joinError) {
      console.error('Failed to link exercises to workout', joinError);
      return respond(req, res, 500, 'Unable to link exercises to workout');
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

    const { payload, exerciseIds, error: validationError } = buildWorkoutPayload(req.body);

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

    const joinError = await replaceWorkoutExercises(supabase, workout.id, exerciseIds);

    if (joinError) {
      console.error('Failed to relink exercises to workout', joinError);
      return respond(req, res, 500, 'Unable to update workout exercises');
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
  fetchWorkoutsByIds,
};

async function fetchWorkouts(supabase, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from('workouts')
    .select('*')
    .order('performed_at', { ascending: false, nullsLast: false })
    .order('created_at', { ascending: false })
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

async function fetchWorkoutsByIds(supabase, ids = []) {
  if (!supabase) {
    return { workouts: [], error: null };
  }

  const unique = Array.from(
    new Set(
      (Array.isArray(ids) ? ids : [ids])
        .map((value) => (value === undefined || value === null ? '' : String(value).trim()))
        .filter((value) => value.length)
    )
  );

  if (!unique.length) {
    return { workouts: [], error: null };
  }

  const { data, error } = await supabase
    .from('workouts')
    .select('*')
    .in('id', unique);

  if (error) {
    return { workouts: [], error };
  }

  const { workouts } = await hydrateWorkouts(supabase, data || []);
  return { workouts, error: null };
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
  const workouts = Array.isArray(input) ? input.map((workout) => ({ ...workout })) : [];

  if (!workouts.length) {
    workouts.forEach((workout) => {
      workout.exercise_ids = [];
      workout.exercises = [];
    });

    return { workouts, workout: workouts[0] };
  }

  if (!supabase) {
    workouts.forEach((workout) => {
      workout.exercise_ids = Array.isArray(workout.exercise_ids)
        ? workout.exercise_ids.map((value) => String(value))
        : [];
      workout.exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
    });

    return { workouts, workout: workouts[0] };
  }

  const workoutIds = workouts
    .map((workout) => workout.id)
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value));

  let joinRows = [];
  if (workoutIds.length) {
    const selection =
      'workout_id, exercise_id, position, order_index, target_sets, target_reps, notes, exercises ( id, name, category, target_muscle, primary_muscle )';

    let queryError = null;
    let queryData = null;

    const initial = await supabase
      .from('workout_exercises')
      .select(selection)
      .in('workout_id', workoutIds);

    if (initial.error && initial.error.code === '42703') {
      const fallback = await supabase
        .from('workout_exercises')
        .select('workout_id, exercise_id, position, exercises ( id, name, category, target_muscle, primary_muscle )')
        .in('workout_id', workoutIds);

      queryError = fallback.error;
      queryData = fallback.data;
    } else {
      queryError = initial.error;
      queryData = initial.data;
    }

    if (queryError) {
      console.error('Failed to load workout_exercises for hydration', queryError);
    } else if (Array.isArray(queryData)) {
      joinRows = queryData;
    }
  }

  const grouped = new Map();
  joinRows.forEach((row) => {
    const workoutId = String(row.workout_id);
    if (!grouped.has(workoutId)) {
      grouped.set(workoutId, { ids: [], exercises: [] });
    }

    const bucket = grouped.get(workoutId);
    if (row.exercise_id !== undefined && row.exercise_id !== null) {
      const exerciseId = String(row.exercise_id);
      if (!bucket.ids.includes(exerciseId)) {
        bucket.ids.push(exerciseId);
      }
    }

    const position = Number.isFinite(row.position)
      ? row.position
      : Number.isFinite(row.order_index)
        ? row.order_index + 1
        : bucket.exercises.length + 1;

    const exerciseMeta = row.exercises || {};

    const toPositiveInteger = (value) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
      }
      return parsed;
    };

    bucket.exercises.push({
      id: exerciseMeta.id || row.exercise_id,
      name: exerciseMeta.name || `Exercise ${row.exercise_id}`,
      category: exerciseMeta.category || null,
      target_muscle: exerciseMeta.target_muscle || null,
      primary_muscle: exerciseMeta.primary_muscle || null,
      target_sets: toPositiveInteger(row.target_sets),
      target_reps: toPositiveInteger(row.target_reps),
      notes: typeof row.notes === 'string' ? row.notes : null,
      position,
    });
  });

  const hydrated = workouts.map((workout) => {
    const workoutId = String(workout.id);
    const bucket = grouped.get(workoutId) || { ids: [], exercises: [] };
    const sortedExercises = bucket.exercises.slice().sort((left, right) => {
      const leftPos = Number.isFinite(left.position) ? left.position : Number.MAX_SAFE_INTEGER;
      const rightPos = Number.isFinite(right.position) ? right.position : Number.MAX_SAFE_INTEGER;
      return leftPos - rightPos;
    });

    return {
      ...workout,
      exercise_ids: bucket.ids,
      exercises: sortedExercises,
    };
  });

  return { workouts: hydrated, workout: hydrated[0] };
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
    },
    exerciseIds,
  };
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

async function replaceWorkoutExercises(supabase, workoutId, exerciseIds, { skipDelete = false } = {}) {
  if (!supabase || !workoutId) {
    return null;
  }

  if (!skipDelete) {
    const { error: deleteError } = await supabase
      .from('workout_exercises')
      .delete()
      .eq('workout_id', workoutId);

    if (deleteError) {
      return deleteError;
    }
  }

  if (!exerciseIds || !exerciseIds.length) {
    return null;
  }

  const uniqueExerciseIds = [];
  const seen = new Set();

  exerciseIds.forEach((raw) => {
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    uniqueExerciseIds.push(value);
  });

  if (!uniqueExerciseIds.length) {
    return null;
  }

  const rowsWithOrder = uniqueExerciseIds.map((exerciseId, index) => ({
    workout_id: workoutId,
    exercise_id: exerciseId,
    order_index: index,
    position: index + 1,
  }));

  const { error: insertError, status: insertStatus } = await supabase
    .from('workout_exercises')
    .insert(rowsWithOrder, { returning: 'minimal' });

  if (!insertError) {
    return null;
  }

  const missingColumnCodes = new Set(['42703', 'PGRST204']);
  if (!missingColumnCodes.has(insertError.code)) {
    if (insertError.code === '23505') {
      return await handleDuplicateInsert(supabase, workoutId, uniqueExerciseIds);
    }

    if (insertError.code === '23514') {
      return await handlePositionConstraint(supabase, workoutId, rowsWithOrder);
    }
    return insertError;
  }

  const rowsWithoutOrder = uniqueExerciseIds.map((exerciseId, index) => ({
    workout_id: workoutId,
    exercise_id: exerciseId,
    position: index + 1,
  }));

  const fallback = await supabase
    .from('workout_exercises')
    .insert(rowsWithoutOrder, { returning: 'minimal' });

  if (fallback.error) {
    if (fallback.error.code === '23505') {
      return await handleDuplicateInsert(supabase, workoutId, uniqueExerciseIds);
    }

    if (fallback.error.code === '23514') {
      return await handlePositionConstraint(supabase, workoutId, rowsWithOrder, { fallbackOnly: true });
    }
  }

  return fallback.error || null;
}

async function handleDuplicateInsert(supabase, workoutId, exerciseIds) {
  if (!exerciseIds || !exerciseIds.length) {
    return null;
  }

  const rowsWithPosition = exerciseIds.map((exerciseId, index) => ({
    workout_id: workoutId,
    exercise_id: exerciseId,
    position: index + 1,
  }));

  const { error } = await supabase
    .from('workout_exercises')
    .insert(rowsWithPosition, { returning: 'minimal' });

  return error || null;
}

async function handlePositionConstraint(supabase, workoutId, rowsWithOrder, { fallbackOnly = false } = {}) {
  if (!supabase || !workoutId) {
    return null;
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('workout_exercises')
    .select('id')
    .eq('workout_id', workoutId)
    .order('position');

  if (existingError) {
    console.error('Failed to read existing workout exercises before relinking', existingError);
    return existingError;
  }

  if (existingRows && existingRows.length) {
    const { error: deleteError } = await supabase
      .from('workout_exercises')
      .delete()
      .eq('workout_id', workoutId);

    if (deleteError) {
      return deleteError;
    }
  }

  const rowsWithoutPosition = rowsWithOrder.map(({ workout_id, exercise_id }, index) => ({
    workout_id,
    exercise_id,
    position: index + 1,
  }));

  const { error } = await supabase
    .from('workout_exercises')
    .insert(rowsWithoutPosition, { returning: 'minimal' });

  return error || null;
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
