const express = require('express');

const SESSION_MODES = new Set(['focus', 'circuit']);
const SESSION_STATUSES = new Set(['in-progress', 'completed', 'aborted']);

function createRouter(supabase) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase is not configured.');
    }

    const { payload, workouts, error } = buildSessionPayload(req.body);
    if (error) {
      return respond(req, res, 400, error);
    }

    const { session, sessionWorkouts, sessionSets, error: creationError } = await createSessionRecord(
      supabase,
      payload,
      workouts
    );

    if (creationError) {
      if (isRlsViolation(creationError)) {
        return respond(
          req,
          res,
          403,
          'Supabase blocked session creation due to row-level security. Run supabase/scripts/session-policies.sql (or supply SUPABASE_SERVICE_ROLE_KEY) and try again.'
        );
      }

      console.error('Failed to create session', creationError);
      return respond(req, res, 500, 'Unable to start session');
    }

    return res.status(201).json({ session, workouts: sessionWorkouts, sets: sessionSets });
  });

  router.patch('/:id/complete', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase is not configured.');
    }

    const sessionId = parseId(req.params.id);
    if (!sessionId) {
      return respond(req, res, 400, 'Invalid session id.');
    }

    const { payload, error } = buildSessionCompletionPayload(req.body);
    if (error) {
      return respond(req, res, 400, error);
    }

    const completeError = await completeSessionRecord(supabase, sessionId, payload);
    if (completeError) {
      if (isRlsViolation(completeError)) {
        return respond(
          req,
          res,
          403,
          'Supabase blocked session updates due to row-level security. Run supabase/scripts/session-policies.sql (or supply SUPABASE_SERVICE_ROLE_KEY) and try again.'
        );
      }

      console.error('Failed to complete session', completeError);
      return respond(req, res, 500, 'Unable to complete session');
    }

    return res.status(200).json({ success: true });
  });

  return router;
}

function buildSessionPayload(body = {}) {
  const planId = toNullableString(body.plan_id);
  const rawPlanName = typeof body.plan_name === 'string' ? body.plan_name.trim() : '';
  const planName = rawPlanName.length ? rawPlanName : null;

  const dayIndex = clampDay(body.day_index);
  const weekIndex = clampPositiveInteger(body.week_index, 1);
  const mode = normalizeMode(body.mode);

  const workoutsInput = Array.isArray(body.workouts) ? body.workouts : [];
  const workouts = workoutsInput.map((workout, workoutIndex) => {
    const workoutIdRaw = workout && workout.id !== undefined && workout.id !== null ? String(workout.id).trim() : null;
    const workoutNameRaw = workout && typeof workout.name === 'string' ? workout.name.trim() : '';
    const workoutName = workoutNameRaw.length ? workoutNameRaw : workoutIdRaw || `Workout ${workoutIndex + 1}`;
    const position = clampPositiveInteger(workout && workout.position, workoutIndex + 1);

    const exercisesInput = Array.isArray(workout && workout.exercises) ? workout.exercises : [];
    const exercises = exercisesInput.map((exercise, exerciseIndex) => {
      const exerciseIdRaw = exercise && exercise.id !== undefined && exercise.id !== null ? String(exercise.id).trim() : null;
      const exerciseNameRaw = exercise && typeof exercise.name === 'string' ? exercise.name.trim() : '';
      const exerciseName = exerciseNameRaw.length ? exerciseNameRaw : exerciseIdRaw || `Exercise ${exerciseIndex + 1}`;

      const targetSets = clampPositiveInteger(exercise && exercise.target_sets, Array.isArray(exercise && exercise.sets) ? exercise.sets.length : null);
      const targetReps = clampPositiveInteger(exercise && exercise.target_reps, null);

      const setsInput = Array.isArray(exercise && exercise.sets) ? exercise.sets : [];
      const sets = setsInput.map((set, setIndex) => ({
        set_number: clampPositiveInteger(set && set.index, setIndex + 1),
        target_reps: clampPositiveInteger(set && set.target_reps, targetReps),
      }));

      return {
        exercise_id: exerciseIdRaw,
        exercise_name: exerciseName,
        target_sets: targetSets,
        target_reps: targetReps,
        sets,
      };
    });

    return {
      workout_id: workoutIdRaw,
      workout_name: workoutName,
      position,
      exercises,
    };
  });

  return {
    payload: {
      planId,
      planName,
      dayIndex,
      weekIndex,
      mode,
    },
    workouts,
    error: null,
  };
}

async function createSessionRecord(supabase, payload, workouts) {
  const sessionInsert = {
    plan_id: payload.planId,
    plan_name: payload.planName,
    day_index: payload.dayIndex,
    week_index: payload.weekIndex,
    mode: payload.mode,
    status: 'in-progress',
    started_at: new Date().toISOString(),
  };

  const { data: sessionRow, error: sessionError } = await supabase
    .from('sessions')
    .insert(sessionInsert)
    .select()
    .single();

  if (sessionError || !sessionRow) {
    return { session: null, sessionWorkouts: [], sessionSets: [], error: sessionError || new Error('Session insertion failed') };
  }

  if (!Array.isArray(workouts) || !workouts.length) {
    return { session: sessionRow, sessionWorkouts: [], sessionSets: [] };
  }

  const workoutRows = workouts.map((workout, index) => ({
    session_id: sessionRow.id,
    workout_id: workout.workout_id || null,
    workout_name: workout.workout_name,
    position: Number.isFinite(workout.position) ? workout.position : index + 1,
  }));

  const { data: insertedWorkouts, error: workoutError } = await supabase
    .from('session_workouts')
    .insert(workoutRows)
    .select('id, workout_id, workout_name, position, session_id');

  if (workoutError) {
    await rollbackSession(supabase, sessionRow.id);
    return { session: null, sessionWorkouts: [], sessionSets: [], error: workoutError };
  }

  const normalizedInserts = Array.isArray(insertedWorkouts) ? insertedWorkouts : [];
  const sessionWorkouts = normalizedInserts.map((row, index) => ({
    id: row.id,
    session_id: row.session_id,
    workout_id: row.workout_id,
    workout_name: row.workout_name,
    position: row.position,
    exercises: workouts[index] ? workouts[index].exercises : [],
  }));

  const sessionSetRows = [];
  sessionWorkouts.forEach((workout, workoutIndex) => {
    const source = workouts[workoutIndex];
    if (!source || !Array.isArray(source.exercises)) {
      return;
    }

    source.exercises.forEach((exercise) => {
      const exerciseId = exercise.exercise_id || null;
      const exerciseName = exercise.exercise_name;
      const targetSets = Number.isFinite(exercise.target_sets) ? exercise.target_sets : null;
      const targetReps = Number.isFinite(exercise.target_reps) ? exercise.target_reps : null;
      const setsInput = Array.isArray(exercise.sets) && exercise.sets.length ? exercise.sets : [{ set_number: 1, target_reps: targetReps }];

      setsInput.forEach((set) => {
        sessionSetRows.push({
          session_workout_id: workout.id,
          exercise_id: exerciseId,
          exercise_name: exerciseName,
          day_index: payload.dayIndex,
          target_sets: targetSets,
          target_reps: targetReps || set.target_reps || null,
          set_number: clampPositiveInteger(set.set_number, 1),
        });
      });
    });
  });

  let insertedSets = [];
  if (sessionSetRows.length) {
    const { data: setRows, error: setError } = await supabase
      .from('session_sets')
      .insert(sessionSetRows)
      .select('id, session_workout_id, exercise_id, exercise_name, set_number, target_reps, completed');

    if (setError) {
      await rollbackSession(supabase, sessionRow.id);
      return { session: null, sessionWorkouts: [], sessionSets: [], error: setError };
    }

    insertedSets = Array.isArray(setRows) ? setRows : [];
  }

  const sessionSets = insertedSets.map((row) => ({
    id: row.id,
    session_workout_id: row.session_workout_id,
    exercise_id: row.exercise_id,
    exercise_name: row.exercise_name,
    set_number: row.set_number,
    target_reps: row.target_reps,
    completed: row.completed,
  }));

  const workoutsWithSets = sessionWorkouts.map((workout) => ({
    ...workout,
    sets: sessionSets.filter((set) => set.session_workout_id === workout.id),
  }));

  return { session: sessionRow, sessionWorkouts: workoutsWithSets, sessionSets };
}

async function completeSessionRecord(supabase, sessionId, payload) {
  const updates = {
    status: payload.status,
    notes: payload.notes,
  };

  if (payload.endedAt) {
    updates.ended_at = payload.endedAt;
  }

  if (Number.isFinite(payload.durationSeconds)) {
    updates.duration_seconds = payload.durationSeconds;
  }

  const { error: sessionUpdateError } = await supabase
    .from('sessions')
    .update(updates)
    .eq('id', sessionId);

  if (sessionUpdateError) {
    return sessionUpdateError;
  }

  if (Array.isArray(payload.sets) && payload.sets.length) {
    for (const setPayload of payload.sets) {
      if (!setPayload || !setPayload.id) {
        continue;
      }

      const setUpdate = {
        completed: Boolean(setPayload.completed),
        actual_reps: Number.isFinite(setPayload.actualReps) ? setPayload.actualReps : null,
        notes: toNullableString(setPayload.notes),
      };

      setUpdate.completed_at = setUpdate.completed ? new Date().toISOString() : null;

      const { error: updateError } = await supabase
        .from('session_sets')
        .update(setUpdate)
        .eq('id', setPayload.id);

      if (updateError) {
        return updateError;
      }
    }
  }

  return null;
}

async function rollbackSession(supabase, sessionId) {
  try {
    await supabase.from('session_workouts').delete().eq('session_id', sessionId);
  } catch (_error) {
    // ignored
  }

  try {
    await supabase.from('sessions').delete().eq('id', sessionId);
  } catch (_error) {
    // ignored
  }
}

function buildSessionCompletionPayload(body = {}) {
  const durationSeconds = clampNonNegativeInteger(body.duration_seconds, null);
  const endedAt = toNullableDate(body.ended_at);
  const rawNotes = typeof body.notes === 'string' ? body.notes.trim() : '';
  const notes = rawNotes.length ? rawNotes : null;

  const setsInput = Array.isArray(body.sets) ? body.sets : [];
  const sets = setsInput
    .map((set) => {
      const id = set && typeof set.id === 'string' && set.id.trim().length ? set.id.trim() : null;
      if (!id) {
        return null;
      }

      return {
        id,
        completed: Boolean(set.completed),
        actualReps: clampNonNegativeInteger(set.actual_reps, null),
        notes: typeof set.notes === 'string' ? set.notes.trim() : '',
      };
    })
    .filter(Boolean);

  return {
    payload: {
      durationSeconds,
      endedAt: endedAt || new Date().toISOString(),
      notes,
      status: 'completed',
      sets,
    },
    error: null,
  };
}

function respond(req, res, status, message) {
  if (req.headers['hx-request']) {
    return res
      .status(status)
      .send(
        `<p class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-orange/40 dark:bg-orange/10 dark:text-orange">${escapeHtml(
          message
        )}</p>`
      );
  }

  return res.status(status).json({ error: message });
}

function escapeHtml(string = '') {
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function clampPositiveInteger(value, fallback = null) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return numeric;
}

function clampNonNegativeInteger(value, fallback = null) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return numeric;
}

function normalizeMode(mode) {
  const candidate = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (SESSION_MODES.has(candidate)) {
    return candidate;
  }

  return 'focus';
}

function parseId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.length) {
    return null;
  }

  return trimmed;
}

function toNullableString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function toNullableDate(value) {
  if (!value) {
    return null;
  }

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  } catch (_error) {
    return null;
  }
}

function isRlsViolation(error) {
  return Boolean(error && error.code === '42501');
}

module.exports = {
  createRouter,
};
