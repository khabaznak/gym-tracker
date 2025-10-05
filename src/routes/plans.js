const express = require('express');

const PLAN_PERIODS = new Set(['weekly', 'bi-weekly', 'monthly']);
const PLAN_STATUSES = new Set(['active', 'inactive']);
const MAX_WEEKS = {
  weekly: 1,
  'bi-weekly': 2,
  monthly: 4,
};

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
      return res.render('plans/list-fragment', {
        layout: false,
        plans: [],
        supabaseReady: false,
        manageable: req.query.mode === 'manage',
        planSchemaMissing: false,
      });
    }

    const { plans, error } = await fetchPlans(supabase);
    const manageable = req.query.mode === 'manage';

    if (error) {
      if (isMissingRelationError(error)) {
        console.warn('Plans schema not found when loading fragment', error);
        return res.render('plans/list-fragment', {
          layout: false,
          plans: [],
          supabaseReady: false,
          manageable,
          planSchemaMissing: true,
        });
      }

      console.error('Failed to load plans from Supabase', error);
      return renderHxError(res, 500, 'Unable to load plans.');
    }

    return res.render('plans/list-fragment', {
      layout: false,
      plans,
      supabaseReady: true,
      manageable,
      planSchemaMissing: false,
    });
  });

  router.get('/:id/fragment', async (req, res) => {
    if (!supabase) {
      return renderHxError(res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parsePlanId(req.params.id);
    if (idError) {
      return renderHxError(res, 400, idError);
    }

    const { plan, error, status } = await fetchPlanById(supabase, id);

    if (error) {
      if (status === 406) {
        return renderHxError(res, 404, 'Plan not found');
      }

      console.error('Failed to load plan', error);
      return renderHxError(res, 500, 'Unable to load plan');
    }

    if (!plan) {
      return renderHxError(res, 404, 'Plan not found');
    }

    return res.render('plans/item-fragment', {
      layout: false,
      plan,
      manageable: req.query.mode === 'manage',
    });
  });

  router.get('/:id/edit', async (req, res) => {
    if (!supabase) {
      return renderHxError(res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parsePlanId(req.params.id);
    if (idError) {
      return renderHxError(res, 400, idError);
    }

    const [planResult, workoutsResult] = await Promise.all([
      fetchPlanById(supabase, id),
      fetchWorkoutsForSelection(supabase),
    ]);

    if (planResult.error) {
      if (planResult.status === 406) {
        return renderHxError(res, 404, 'Plan not found');
      }

      console.error('Failed to load plan for editing', planResult.error);
      return renderHxError(res, 500, 'Unable to load plan');
    }

    if (!planResult.plan) {
      return renderHxError(res, 404, 'Plan not found');
    }

    if (workoutsResult.error) {
      console.error('Failed to load workouts for plan editing', workoutsResult.error);
    }

    return res.render('plans/edit-form', {
      layout: false,
      plan: planResult.plan,
      workouts: workoutsResult.workouts || [],
    });
  });

  router.get('/', async (_req, res) => {
    if (!supabase) {
      return res.status(200).json({ plans: [], message: 'Supabase not configured' });
    }

    const { plans, error } = await fetchPlans(supabase);

    if (error) {
      console.error('Failed to load plans from Supabase', error);
      return res.status(500).json({ error: 'Unable to load plans' });
    }

    return res.json({ plans });
  });

  router.get('/:id', async (req, res) => {
    if (!supabase) {
      return res.status(200).json({ plan: null, message: 'Supabase not configured' });
    }

    const { id, error: idError } = parsePlanId(req.params.id);
    if (idError) {
      return res.status(400).json({ error: idError });
    }

    const { plan, error, status } = await fetchPlanById(supabase, id);

    if (error) {
      if (status === 406) {
        return res.status(404).json({ error: 'Plan not found' });
      }

      console.error('Failed to load plan', error);
      return res.status(500).json({ error: 'Unable to load plan' });
    }

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    return res.json({ plan });
  });

  router.post('/', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { payload, assignments, error } = buildPlanPayload(req.body);

    if (error) {
      return respond(req, res, 400, error);
    }

    const { data, error: insertError } = await supabase
      .from('plans')
      .insert(payload)
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create plan', insertError);
      return respond(req, res, 500, 'Unable to create plan');
    }

    const linkError = await replacePlanAssignments(supabase, data.id, assignments, {
      skipDelete: true,
      period: payload.period,
    });

    if (linkError) {
      await rollbackPlanOnLinkFailure(supabase, data.id);
      if (isRlsViolation(linkError)) {
        return respond(
          req,
          res,
          403,
          'Supabase blocked plan workouts due to row-level security. Run supabase/scripts/plan-policies.sql (or configure SUPABASE_SERVICE_ROLE_KEY) and try again.'
        );
      }
      console.error('Failed to link workouts to plan', linkError);
      return respond(req, res, 500, 'Unable to connect workouts to plan');
    }

    const { plan } = await hydratePlans(supabase, [data]);
    const hydrated = plan || data;

    if (req.headers['hx-request']) {
      return res.status(201).render('plans/create-response', {
        layout: false,
        plan: hydrated,
      });
    }

    return res.status(201).json({ plan: hydrated });
  });

  router.put('/:id', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parsePlanId(req.params.id);
    if (idError) {
      return respond(req, res, 400, idError);
    }

    const { payload, assignments, error: validationError } = buildPlanPayload(req.body);

    if (validationError) {
      return respond(req, res, 400, validationError);
    }

    const { data: updatedRows, error: updateError, status: updateStatus } = await supabase
      .from('plans')
      .update(payload)
      .eq('id', id)
      .select();

    if (updateError) {
      if (updateStatus === 406) {
        return respond(req, res, 404, 'Plan not found');
      }

      console.error('Failed to update plan', updateError);
      return respond(req, res, 500, 'Unable to update plan');
    }

    let plan = Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : null;

    if (!plan) {
      const { plan: fetched, error: fetchError, status: fetchStatus } = await fetchPlanById(supabase, id);

      if (fetchError) {
        if (fetchStatus === 406) {
          return respond(req, res, 404, 'Plan not found');
        }

        console.error('Failed to load updated plan', fetchError);
        return respond(req, res, 500, 'Unable to update plan');
      }

      if (!fetched) {
        return respond(req, res, 404, 'Plan not found');
      }

      plan = fetched;
    }

    const linkError = await replacePlanAssignments(supabase, plan.id, assignments, {
      period: (plan && plan.period) || payload.period,
    });

    if (linkError) {
      if (isRlsViolation(linkError)) {
        return respond(
          req,
          res,
          403,
          'Supabase blocked plan workouts due to row-level security. Run supabase/scripts/plan-policies.sql (or configure SUPABASE_SERVICE_ROLE_KEY) and try again.'
        );
      }
      console.error('Failed to relink workouts to plan', linkError);
      return respond(req, res, 500, 'Unable to update plan workouts');
    }

    const hydrated = (await hydratePlans(supabase, [plan])).plan || plan;

    if (req.headers['hx-request']) {
      return res.render('plans/update-response', {
        layout: false,
        plan: hydrated,
      });
    }

    return res.json({ plan: hydrated });
  });

  router.delete('/:id', async (req, res) => {
    if (!supabase) {
      return respond(req, res, 501, 'Supabase not configured');
    }

    const { id, error: idError } = parsePlanId(req.params.id);
    if (idError) {
      return respond(req, res, 400, idError);
    }

    const { error, status } = await supabase
      .from('plans')
      .delete()
      .eq('id', id);

    if (error) {
      if (status === 406) {
        return respond(req, res, 404, 'Plan not found');
      }

      console.error('Failed to delete plan', error);
      return respond(req, res, 500, 'Unable to delete plan');
    }

    if (req.headers['hx-request']) {
      return res.send('');
    }

    return res.status(204).end();
  });

  return router;
}

async function fetchPlans(supabase, { limit = 50 } = {}) {
  if (!supabase) {
    return { plans: [], error: null };
  }

  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return { plans: [], error };
  }

  const { plans } = await hydratePlans(supabase, data || []);
  return { plans, error: null };
}

async function fetchPlanById(supabase, id) {
  const { data, error, status } = await supabase
    .from('plans')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return { plan: null, error, status };
  }

  if (!data) {
    return { plan: null, error: null, status: 404 };
  }

  const { plan } = await hydratePlans(supabase, [data]);
  return { plan: plan || data, error: null, status: 200 };
}

async function fetchWorkoutsForSelection(supabase) {
  if (!supabase) {
    return { workouts: [], error: null };
  }

  const { data, error } = await supabase
    .from('workouts')
    .select('id, name, rest_interval, description')
    .order('name', { ascending: true })
    .limit(200);

  return { workouts: data || [], error };
}

async function fetchActivePlan(supabase) {
  if (!supabase) {
    return { plan: null, error: null };
  }

  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { plan: null, error };
  }

  if (!data) {
    return { plan: null, error: null };
  }

  const { plan } = await hydratePlans(supabase, [data]);
  return { plan: plan || data, error: null };
}

async function hydratePlans(supabase, input) {
  const plans = Array.isArray(input) ? input.map((plan) => ({ ...plan })) : [];

  if (!plans.length) {
    plans.forEach((plan) => {
      plan.assignments = [];
      plan.schedule = buildPlanSchedule([], normalizePeriod(plan.period));
    });

    return { plans, plan: plans[0] };
  }

  if (!supabase) {
    plans.forEach((plan) => {
      plan.assignments = Array.isArray(plan.assignments) ? plan.assignments : [];
      const period = normalizePeriod(plan.period);
      plan.schedule = buildPlanSchedule(plan.assignments, period);
      plan.period = period;
      plan.status = normalizeStatus(plan.status);
    });

    return { plans, plan: plans[0] };
  }

  const planIds = plans
    .map((plan) => plan.id)
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value));

  let joinRows = [];
  if (planIds.length) {
    const { data, error } = await supabase
      .from('plan_workouts')
      .select('plan_id, workout_id, week_index, day_of_week, position, workouts ( id, name, description )')
      .in('plan_id', planIds);

    if (error) {
      console.error('Failed to load plan_workouts for hydration', error);
    } else if (Array.isArray(data)) {
      joinRows = data;
    }
  }

  const grouped = new Map();
  joinRows.forEach((row) => {
    const planId = String(row.plan_id);
    if (!grouped.has(planId)) {
      grouped.set(planId, []);
    }

    grouped.get(planId).push({
      workout_id: row.workout_id,
      week_index: row.week_index,
      day_of_week: row.day_of_week,
      position: row.position,
      workout: row.workouts || null,
    });
  });

  const hydrated = plans.map((plan) => {
    const planId = String(plan.id);
    const assignments = (grouped.get(planId) || []).slice();

    assignments.sort((left, right) => {
      const weekLeft = Number.isFinite(left.week_index) ? left.week_index : Number.MAX_SAFE_INTEGER;
      const weekRight = Number.isFinite(right.week_index) ? right.week_index : Number.MAX_SAFE_INTEGER;
      if (weekLeft !== weekRight) {
        return weekLeft - weekRight;
      }

      const dayLeft = Number.isFinite(left.day_of_week) ? left.day_of_week : Number.MAX_SAFE_INTEGER;
      const dayRight = Number.isFinite(right.day_of_week) ? right.day_of_week : Number.MAX_SAFE_INTEGER;
      if (dayLeft !== dayRight) {
        return dayLeft - dayRight;
      }

      const posLeft = Number.isFinite(left.position) ? left.position : Number.MAX_SAFE_INTEGER;
      const posRight = Number.isFinite(right.position) ? right.position : Number.MAX_SAFE_INTEGER;
      return posLeft - posRight;
    });

    const normalizedPeriod = normalizePeriod(plan.period);
    const normalizedStatus = normalizeStatus(plan.status);
    const schedule = buildPlanSchedule(assignments, normalizedPeriod);

    return {
      ...plan,
      period: normalizedPeriod,
      status: normalizedStatus,
      assignments,
      schedule,
    };
  });

  return { plans: hydrated, plan: hydrated[0] };
}

function buildPlanPayload(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return { error: 'Plan name is required' };
  }

  const periodInput = typeof body.period === 'string' ? body.period.trim() : 'weekly';
  const period = normalizePeriod(periodInput);

  const statusInput = typeof body.status === 'string' ? body.status.trim() : 'inactive';
  const status = normalizeStatus(statusInput);

  const assignments = normalizeAssignmentsInput(body, period);

  return {
    payload: {
      name,
      description: toNullableString(body.description),
      label: toNullableString(body.label),
      period,
      status,
    },
    assignments,
    error: null,
  };
}

function normalizeAssignmentsInput(body = {}, period = 'weekly') {
  const weeks = ensureArray(body.assignment_week);
  const days = ensureArray(body.assignment_day);
  const workouts = ensureArray(body.assignment_workout);

  const maxWeeks = MAX_WEEKS[period] || 1;
  const assignments = [];

  for (let index = 0; index < workouts.length; index += 1) {
    const workoutRaw = workouts[index];
    const workoutId = workoutRaw === undefined || workoutRaw === null ? '' : String(workoutRaw).trim();
    if (!workoutId) {
      continue;
    }

    let week = Number.parseInt(Array.isArray(weeks) ? weeks[index] : weeks, 10);
    if (!Number.isFinite(week)) {
      week = 1;
    }

    week = Math.min(Math.max(week, 1), maxWeeks);

    let day = Number.parseInt(Array.isArray(days) ? days[index] : days, 10);
    if (!Number.isFinite(day) || day < 1 || day > 7) {
      continue;
    }

    assignments.push({
      workout_id: workoutId,
      week_index: week,
      day_of_week: day,
    });
  }

  assignments.sort((left, right) => {
    if (left.week_index !== right.week_index) {
      return left.week_index - right.week_index;
    }

    if (left.day_of_week !== right.day_of_week) {
      return left.day_of_week - right.day_of_week;
    }

    return 0;
  });

  return assignments;
}

async function replacePlanAssignments(supabase, planId, assignments, { skipDelete = false, period = 'weekly' } = {}) {
  if (!supabase || !planId) {
    return null;
  }

  if (!skipDelete) {
    const { error: deleteError } = await supabase
      .from('plan_workouts')
      .delete()
      .eq('plan_id', planId);

    if (deleteError) {
      return deleteError;
    }
  }

  if (!assignments || !assignments.length) {
    return null;
  }

  const normalized = [];
  const seen = new Set();

  assignments.forEach((assignment, index) => {
    const workoutId = assignment.workout_id === undefined || assignment.workout_id === null
      ? ''
      : String(assignment.workout_id).trim();

    if (!workoutId) {
      return;
    }

    const week = clampWeek(assignment.week_index, MAX_WEEKS, period);
    const day = clampDay(assignment.day_of_week);

    const key = `${week}|${day}|${workoutId}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    normalized.push({
      plan_id: planId,
      workout_id: workoutId,
      week_index: week,
      day_of_week: day,
      order_index: index,
      position: index + 1,
    });
  });

  if (!normalized.length) {
    return null;
  }

  const { error: insertError } = await supabase
    .from('plan_workouts')
    .insert(normalized, { returning: 'minimal' });

  if (!insertError) {
    return null;
  }

  const missingColumnCodes = new Set(['42703', 'PGRST204']);
  if (missingColumnCodes.has(insertError.code)) {
    const fallbackRows = normalized.map(({ order_index, ...rest }) => rest);
    const { error: fallbackError } = await supabase
      .from('plan_workouts')
      .insert(fallbackRows, { returning: 'minimal' });

    return fallbackError || null;
  }

  if (insertError.code === '23505') {
    const fallbackRows = normalized.map((row, index) => ({
      plan_id: row.plan_id,
      workout_id: row.workout_id,
      week_index: row.week_index,
      day_of_week: row.day_of_week,
      position: index + 1,
    }));

    const { error: fallbackError } = await supabase
      .from('plan_workouts')
      .insert(fallbackRows, { returning: 'minimal' });

    return fallbackError || null;
  }

  if (insertError.code === '23514') {
    const { error: fallbackError } = await supabase
      .from('plan_workouts')
      .insert(normalized.map(({ order_index, position, ...rest }, index) => ({
        ...rest,
        position: index + 1,
      })), { returning: 'minimal' });

    return fallbackError || null;
  }

  return insertError;
}

function parsePlanId(param = '') {
  const trimmed = String(param ?? '').trim();
  if (!trimmed) {
    return { error: 'Invalid plan id' };
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

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function clampWeek(value, lookup, period) {
  const max = lookup && lookup[period] ? lookup[period] : 1;
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return 1;
  }

  return Math.min(Math.max(numeric, 1), max);
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

function normalizePeriod(period) {
  if (PLAN_PERIODS.has(period)) {
    return period;
  }

  return 'weekly';
}

function normalizeStatus(status) {
  if (PLAN_STATUSES.has(status)) {
    return status;
  }

  return 'inactive';
}

function buildPlanSchedule(assignments = [], period = 'weekly') {
  const periodKey = PLAN_PERIODS.has(period) ? period : 'weekly';
  const weeksCount = MAX_WEEKS[periodKey] || 1;
  const dayNames = [
    { key: 'mon', label: 'Monday' },
    { key: 'tue', label: 'Tuesday' },
    { key: 'wed', label: 'Wednesday' },
    { key: 'thu', label: 'Thursday' },
    { key: 'fri', label: 'Friday' },
    { key: 'sat', label: 'Saturday' },
    { key: 'sun', label: 'Sunday' },
  ];

  const buckets = new Map();

  assignments.forEach((assignment) => {
    let weekIndex = Number.parseInt(assignment.week_index, 10);
    if (!Number.isFinite(weekIndex)) {
      weekIndex = 1;
    }
    weekIndex = clampWeek(weekIndex, MAX_WEEKS, periodKey);

    const dayIndexRaw = Number.parseInt(assignment.day_of_week, 10);
    if (!Number.isFinite(dayIndexRaw)) {
      return;
    }
    const dayIndex = clampDay(dayIndexRaw);

    const key = `${weekIndex}|${dayIndex}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }

    const workouts = buckets.get(key);
    const workoutName = assignment.workout && assignment.workout.name
      ? assignment.workout.name
      : assignment.workout_id
        ? `Workout ${assignment.workout_id}`
        : 'Workout';

    const positionValue = Number.parseInt(assignment.position, 10);
    workouts.push({
      id: assignment.workout_id || (assignment.workout && assignment.workout.id) || null,
      name: workoutName,
      position: Number.isFinite(positionValue) ? positionValue : workouts.length + 1,
    });
  });

  const weeks = [];
  let hasWorkouts = false;

  for (let week = 1; week <= weeksCount; week += 1) {
    const days = [];
    let weekHasWorkouts = false;

    for (let day = 1; day <= 7; day += 1) {
      const key = `${week}|${day}`;
      const workouts = (buckets.get(key) || []).slice().sort((left, right) => {
        const leftPos = Number.isFinite(left.position) ? left.position : Number.MAX_SAFE_INTEGER;
        const rightPos = Number.isFinite(right.position) ? right.position : Number.MAX_SAFE_INTEGER;
        return leftPos - rightPos;
      });

      if (workouts.length) {
        hasWorkouts = true;
        weekHasWorkouts = true;
      }

      const dayMeta = dayNames[day - 1];

      days.push({
        day_index: day,
        day_key: dayMeta ? dayMeta.key : `day-${day}`,
        day_name: dayMeta ? dayMeta.label : `Day ${day}`,
        workouts,
      });
    }

    weeks.push({
      number: week,
      days,
      hasWorkouts: weekHasWorkouts,
    });
  }

  return {
    weeks,
    hasWorkouts,
    dayHeaders: dayNames.map((day) => ({ key: day.key, label: day.label })),
  };
}

function isRlsViolation(error) {
  return Boolean(error && error.code === '42501');
}

async function rollbackPlanOnLinkFailure(supabase, planId) {
  if (!supabase || !planId) {
    return;
  }

  try {
    await supabase.from('plan_workouts').delete().eq('plan_id', planId);
    await supabase.from('plans').delete().eq('id', planId);
  } catch (cleanupError) {
    console.warn('Failed to roll back plan after link failure', cleanupError);
  }
}

function isMissingRelationError(error) {
  if (!error) {
    return false;
  }

  if (error.code === '42P01') {
    return true;
  }

  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return message.includes('does not exist');
}

module.exports = {
  createRouter,
  fetchPlans,
  fetchPlanById,
  fetchWorkoutsForSelection,
  fetchActivePlan,
};
