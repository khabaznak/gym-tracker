const express = require('express');

module.exports = (supabase) => {
  const router = express.Router();

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

    const {
      name,
      category,
      primary_muscle,
      secondary_muscles,
      equipment,
      tempo,
      notes,
      cues,
      video_url,
    } = req.body;

    const trimmedName = typeof name === 'string' ? name.trim() : '';

    if (!trimmedName) {
      return respond(req, res, 400, 'Exercise name is required');
    }

    const normalizedVideoUrl = normalizeUrl(video_url);
    if (normalizedVideoUrl === false) {
      return respond(req, res, 400, 'Video link must be a valid URL starting with http or https.');
    }

    const payload = {
      name: trimmedName,
      category: toNullableString(category),
      primary_muscle: toNullableString(primary_muscle),
      secondary_muscles: toNullableString(secondary_muscles),
      equipment: toNullableString(equipment),
      tempo: toNullableString(tempo),
      notes: toNullableString(notes),
      cues: toNullableString(cues),
      video_url: normalizedVideoUrl,
    };

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
