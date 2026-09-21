-- LiftLog — Supabase schema.
-- Paste the whole file into the Supabase SQL Editor and run it once.
--
-- Notes on a few deliberate choices:
--
--   created_at / updated_at are TEXT, not timestamptz. They are the client's
--   own ISO strings and the sync merge compares them as strings, so they must
--   round-trip byte for byte. Postgres would happily reformat a timestamptz
--   ("...Z" becomes "+00:00") and quietly break every comparison.
--
--   server_updated_at IS a real timestamp, set by the server on every write.
--   It is what the client pages through when pulling, so a wrong clock on the
--   phone can never cause a row to be skipped.
--
--   Booleans are smallint 0/1 to match exactly what the app stores locally.
--   A real boolean would come back as true/false and need converting on every
--   pull, which is one more place to get it wrong.
--
--   There are no foreign keys between these tables. Rows reference each other
--   by client-generated UUID and deletions are tombstones, so a child can
--   legitimately arrive before its parent. user_id is the only real reference.

-- ---------------------------------------------------------------- helpers

-- search_path is pinned empty so the function can't be hijacked by an object
-- someone creates earlier on the path. now() lives in pg_catalog, which is
-- always searched regardless.
create or replace function public.set_server_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.server_updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- tables

create table if not exists public.exercises (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  name              text not null,
  name_key          text not null,
  muscle_group      text,
  tracks            text,
  is_custom         smallint not null default 0,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.places (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  name              text not null,
  lat               double precision,
  lng               double precision,
  radius_m          integer,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.templates (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  name              text not null,
  place_id          uuid,
  position          integer,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.template_exercises (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  template_id       uuid not null,
  exercise_id       uuid not null,
  position          integer,
  target_sets       integer,
  target_reps       integer,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.workouts (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  started_at        text not null,
  ended_at          text,
  place_id          uuid,
  template_id       uuid,
  plan              jsonb,
  notes             text,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.sets (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  workout_id        uuid not null,
  exercise_id       uuid not null,
  set_index         integer,
  weight            numeric(7,2),
  reps              integer,
  seconds           integer,
  rpe               numeric(3,1),
  failed            smallint not null default 0,
  is_warmup         smallint not null default 0,
  is_dropset        smallint not null default 0,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.exercise_notes (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  workout_id        uuid not null,
  exercise_id       uuid not null,
  body              text,
  created_at        text not null,
  updated_at        text not null,
  deleted           smallint not null default 0,
  server_updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- triggers

do $$
declare
  t text;
begin
  foreach t in array array[
    'exercises', 'places', 'templates', 'template_exercises',
    'workouts', 'sets', 'exercise_notes'
  ]
  loop
    execute format(
      'drop trigger if exists set_server_updated_at on public.%I', t);
    execute format(
      'create trigger set_server_updated_at before update on public.%I
       for each row execute function public.set_server_updated_at()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- indexes

create index if not exists exercises_sync_idx          on public.exercises (user_id, server_updated_at);
create index if not exists places_sync_idx             on public.places (user_id, server_updated_at);
create index if not exists templates_sync_idx          on public.templates (user_id, server_updated_at);
create index if not exists template_exercises_sync_idx on public.template_exercises (user_id, server_updated_at);
create index if not exists workouts_sync_idx           on public.workouts (user_id, server_updated_at);
create index if not exists sets_sync_idx               on public.sets (user_id, server_updated_at);
create index if not exists exercise_notes_sync_idx     on public.exercise_notes (user_id, server_updated_at);

-- ---------------------------------------------------------------- row level security
--
-- The anon key shipped in the app is public by design. THIS is what stops it
-- reading anyone's data: every row is bound to a user, and every policy checks
-- that the caller is that user. Pair it with signups disabled in the dashboard.

do $$
declare
  t text;
begin
  foreach t in array array[
    'exercises', 'places', 'templates', 'template_exercises',
    'workouts', 'sets', 'exercise_notes'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    -- (select auth.uid()) rather than bare auth.uid(): Postgres evaluates the
    -- subselect once per query instead of once per row.
    execute format(
      'create policy own_rows on public.%I
         for all
         to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t);

    -- Depending on the project's Data API settings, new tables are not exposed
    -- to the REST API until a role is granted access. RLS above decides WHICH
    -- rows; this decides whether the table is reachable at all. Only signed-in
    -- users get it -- anon gets nothing.
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end;
$$;
