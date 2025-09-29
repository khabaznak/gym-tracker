# Manage Plans Checklist

## 1. Apply schema updates
Run the project migrations (preferred) so the plans tables are created:

```bash
supabase db push
```

If you need to apply the SQL manually, run the script in the Supabase SQL editor or through `supabase db`:

```sql
\i supabase/scripts/plan-schema.sql
```

These steps add the `plans` and `plan_workouts` tables (with constraints and triggers). Adjust paths if you copy the SQL manually.

## 2. Ensure RLS policies
If row level security is enabled, apply the policies (replace `anon` with your runtime role if needed):

```sql
\i supabase/scripts/plan-policies.sql
```

If you scope data per user/team, edit the `using/with check` clauses before running.

## 3. Manual test pass
1. Open **Manage Plans**.
2. Create a weekly plan with a description, mark `active`, then add workouts to several days. Save.
3. Edit the plan, change period (e.g., bi-weekly), adjust day assignments (add/remove workouts). Save and confirm updates.
4. Delete the plan via the modal and ensure it disappears.
5. Refresh the page after each step to confirm Supabase stored the changes.

Optional: hit `/plans` and `/plans/:id` endpoints in Postman to verify JSON payloads.
