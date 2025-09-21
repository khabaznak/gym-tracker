const express = require('express');

module.exports = (supabase) => {
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

  router.get('/fragment', async (_req, res) => {
    if (!supabase) {
      return res.render('exercises/list-fragment', {
        layout: false,
        exercises: [],
        supabaseReady: false,
      });
    }

    const { data, error } = await fetchExercises(supabase);

    if (error) {
      console.error('Failed to load exercises from Supabase', error);
      return renderHxError(res, 500, 'Unable to load exercises.');
    }

    return res.render('exercises/list-fragment', {
      layout: false,
      exercises: data,
      supabaseReady: true,
    });
  });

  router.get('/', async (_req, res) => {
    if (!supabase) {
      return res.status(200).json({ exercises: [], message: 'Supabase not configured' });
    }

    const { data, error } = await fetchExercises(supabase);

    if (error) {
      console.error('Failed to load exercises from Supabase', error);
      return res.status(500).json({ error: 'Unable to load exercises' });
    }

    return res.json({ exercises: data });
  });

  router.post('/', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { payload, error: validationError } = buildExercisePayload(req.body);

    if (validationError) {
      return respond(req, res, 400, validationError);
    }

    const { data, error } = await supabase.from('exercises').insert(payload).select().single();

    if (error) {
      console.error('Failed to create exercise', error);
      return respond(req, res, 500, 'Unable to create exercise');
    }

    if (req.headers['hx-request']) {
      return res.status(201).render('exercises/create-response', {
        layout: false,
        exercise: data,
      });
    }

    return res.status(201).json({ exercise: data });
  });

  router.get('/:id/fragment', async (req, res) => {
    if (!supabase) {
      return renderHxError(res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseExerciseId(req.params.id);
    if (idError) {
      return renderHxError(res, 400, idError);
    }

    const { data, error, status } = await fetchExerciseById(supabase, id);

    if (error) {
      if (status === 406) {
        return renderHxError(res, 404, 'Exercise not found');
      }

      console.error('Failed to load exercise', error);
      return renderHxError(res, 500, 'Unable to load exercise');
    }

    if (!data) {
      return renderHxError(res, 404, 'Exercise not found');
    }

    return res.render('exercises/item-fragment', {
      layout: false,
      exercise: data,
    });
  });

  router.get('/:id/edit', async (req, res) => {
    if (!supabase) {
      return renderHxError(res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseExerciseId(req.params.id);
    if (idError) {
      return renderHxError(res, 400, idError);
    }

    const { data, error, status } = await fetchExerciseById(supabase, id);

    if (error) {
      if (status === 406) {
        return renderHxError(res, 404, 'Exercise not found');
      }

      console.error('Failed to load exercise for editing', error);
      return renderHxError(res, 500, 'Unable to load exercise');
    }

    if (!data) {
      return renderHxError(res, 404, 'Exercise not found');
    }

    return res.render('exercises/edit-form', {
      layout: false,
      exercise: data,
    });
  });

  router.put('/:id', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseExerciseId(req.params.id);
    if (idError) {
      return respond(req, res, 400, idError);
    }

    const { payload, error: validationError } = buildExercisePayload(req.body);

    if (validationError) {
      return respond(req, res, 400, validationError);
    }

    const { data: updatedRows, error: updateError, status: updateStatus } = await supabase
      .from('exercises')
      .update(payload)
      .eq('id', id)
      .select()
      .throwOnError();

    if (updateError) {
      if (updateStatus === 406) {
        return respond(req, res, 404, 'Exercise not found');
      }

      console.error('Failed to update exercise', updateError);
      return respond(req, res, 500, 'Unable to update exercise');
    }

    let exercise = Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : null;

    if (!exercise) {
      const {
        data: fetched,
        error: fetchError,
        status: fetchStatus,
      } = await fetchExerciseById(supabase, id);

      if (fetchError) {
        if (fetchStatus === 406) {
          return respond(req, res, 404, 'Exercise not found');
        }

        console.error('Failed to load updated exercise', fetchError);
        return respond(req, res, 500, 'Unable to update exercise');
      }

      if (!fetched) {
        return respond(req, res, 404, 'Exercise not found');
      }

      exercise = fetched;
    }

    if (req.headers['hx-request']) {
      return res.render('exercises/update-response', {
        layout: false,
        exercise,
      });
    }

    return res.json({ exercise });
  });

  router.delete('/:id', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parseExerciseId(req.params.id);
    if (idError) {
      return respond(req, res, 400, idError);
    }

    const { error, status } = await supabase
      .from('exercises')
      .delete()
      .eq('id', id);

    if (error) {
      if (status === 406) {
        return respond(req, res, 404, 'Exercise not found');
      }

      console.error('Failed to delete exercise', error);
      return respond(req, res, 500, 'Unable to delete exercise');
    }

    if (req.headers['hx-request']) {
      return res.send('');
    }

    return res.status(204).end();
  });

  router.get('/:id', async (req, res) => {
    if (!supabase) {
      return res.status(200).json({ exercise: null, message: 'Supabase not configured' });
    }

    const { id, error: idError } = parseExerciseId(req.params.id);
    if (idError) {
      return res.status(400).json({ error: idError });
    }

    const { data, error, status } = await fetchExerciseById(supabase, id);

    if (error) {
      if (status === 406) {
        return res.status(404).json({ error: 'Exercise not found' });
      }

      console.error('Failed to load exercise', error);
      return res.status(500).json({ error: 'Unable to load exercise' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Exercise not found' });
    }

    return res.json({ exercise: data });
  });

  return router;
};

async function fetchExercises(supabase) {
  return supabase
    .from('exercises')
    .select('*')
    .order('name', { ascending: true })
    .limit(100);
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

function normalizePositiveInteger(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = typeof value === 'string' ? value.trim() : value;

  if (normalized === '') {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return false;
  }

  return parsed;
}

function buildExercisePayload(body = {}) {
  const trimmedName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!trimmedName) {
    return { error: 'Exercise name is required' };
  }

  const normalizedVideoUrl = normalizeUrl(body.video_url);
  if (normalizedVideoUrl === false) {
    return { error: 'Video link must be a valid URL starting with http or https.' };
  }

  const targetMuscleValue =
    typeof body.target_muscle === 'string' && body.target_muscle.trim()
      ? body.target_muscle
      : body.primary_muscle;
  const normalizedTargetMuscle = toNullableString(targetMuscleValue);

  if (!normalizedTargetMuscle) {
    return { error: 'Target muscle is required' };
  }

  const repetitionsValue = normalizePositiveInteger(body.target_repetitions);
  if (repetitionsValue === null) {
    return { error: 'Target repetitions is required' };
  }
  if (repetitionsValue === false) {
    return { error: 'Target repetitions must be a positive whole number.' };
  }

  const setsValue = normalizePositiveInteger(body.target_sets);
  if (setsValue === null) {
    return { error: 'Target sets is required' };
  }
  if (setsValue === false) {
    return { error: 'Target sets must be a positive whole number.' };
  }

  return {
    payload: {
      name: trimmedName,
      category: toNullableString(body.category),
      primary_muscle: toNullableString(body.primary_muscle),
      target_muscle: normalizedTargetMuscle,
      target_sets: setsValue,
      target_repetitions: repetitionsValue,
      secondary_muscles: toNullableString(body.secondary_muscles),
      equipment: toNullableString(body.equipment),
      tempo: toNullableString(body.tempo),
      notes: toNullableString(body.notes),
      cues: toNullableString(body.cues),
      video_url: normalizedVideoUrl,
    },
  };
}

async function fetchExerciseById(supabase, id) {
  return supabase.from('exercises').select('*').eq('id', id).maybeSingle();
}

function parseExerciseId(param = '') {
  const trimmed = String(param ?? '').trim();
  if (!trimmed) {
    return { error: 'Invalid exercise id' };
  }

  const asNumber = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asNumber) && String(asNumber) === trimmed) {
    return { id: asNumber };
  }

  return { id: trimmed };
}
