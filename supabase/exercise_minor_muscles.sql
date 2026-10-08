-- Minor muscles an exercise also works, as a JSON array of muscle names.
-- The major muscle stays in muscle_group. Applied as migration
-- `exercise_minor_muscles` on 2026-10-08. Additive: older builds ignore it.
alter table public.exercises
  add column if not exists secondary_muscles jsonb not null default '[]'::jsonb;
