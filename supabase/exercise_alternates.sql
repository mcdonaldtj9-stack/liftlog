-- Alternates: exercises you'd do instead when the usual one is taken, as a
-- JSON array of exercise ids, kept in both directions. And per session, which
-- exercise was swapped in for which: { "<alternate id>": "<routine's original id>" }.
-- Applied as migration `exercise_alternates`. Additive: older builds ignore both.
alter table public.exercises
  add column if not exists alternates jsonb not null default '[]'::jsonb;
alter table public.workouts
  add column if not exists swaps jsonb;
