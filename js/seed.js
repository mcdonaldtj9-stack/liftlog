/* Starter exercise list.
   Seeded once, on first run, only when the exercise store is empty. Everything
   here is editable and deletable, and you can add unlimited exercises of your
   own — this list is a head start, not a catalogue you're stuck inside.

   Covers both of your setups: machine/Smith/cable work for Planet Fitness, and
   free-barbell work for the garage.

   tracks:
     'weight_reps'     weight x reps            (most lifts)
     'bodyweight_reps' optional added weight x reps (pull-ups, dips, push-ups)
     'time'            duration in seconds      (planks, carries, holds) */

/* Your gyms. Coordinates are captured on site in step 3; until then you pick
   the location by hand and everything place-aware already works. */
export const SEED_PLACES = [
  'Planet Fitness — Fenton',
  'Planet Fitness — Effingham',
  'Effingham Garage',
];

/* Where the scales are, as opposed to where the lifting is. Fixed ids, so
   every install creates the same two records and sync can't end up with a
   second "Home — Fenton". */
export const HOME_PLACES = [
  { id: '5c0e4a7e-0b1d-4f8a-9c3e-000000000001', name: 'Home — Fenton' },
  { id: '5c0e4a7e-0b1d-4f8a-9c3e-000000000002', name: 'Home — Effingham' },
];

export const MUSCLE_GROUPS = [
  'Chest', 'Back', 'Shoulders', 'Quads', 'Hamstrings',
  'Glutes', 'Calves', 'Biceps', 'Triceps', 'Core', 'Other',
];

/* An exercise's minor muscles: known names only, never the major one, no
   repeats. Records from before minor muscles existed have none. */
export function minorMuscles(exercise) {
  const list = Array.isArray(exercise?.secondary_muscles) ? exercise.secondary_muscles : [];
  return [...new Set(list)].filter((m) =>
    MUSCLE_GROUPS.includes(m) && m !== 'Other' && m !== exercise?.muscle_group);
}

const W = 'weight_reps';
const B = 'bodyweight_reps';
const T = 'time';

export const SEED_EXERCISES = [
  // Chest
  ['Barbell Bench Press',        'Chest',      W],
  ['Dumbbell Bench Press',       'Chest',      W],
  ['Incline Dumbbell Press',     'Chest',      W],
  ['Smith Machine Bench Press',  'Chest',      W],
  ['Chest Press Machine',        'Chest',      W],
  ['Incline Chest Press Machine','Chest',      W],
  ['Pec Deck',                   'Chest',      W],
  ['Cable Fly',                  'Chest',      W],
  ['Push-Up',                    'Chest',      B],

  // Back
  ['Deadlift',                   'Back',       W],
  ['Barbell Row',                'Back',       W],
  ['Dumbbell Row',               'Back',       W],
  ['T-Bar Row',                  'Back',       W],
  ['Lat Pulldown',               'Back',       W],
  ['Seated Cable Row',           'Back',       W],
  ['Straight-Arm Pulldown',      'Back',       W],
  ['Pull-Up',                    'Back',       B],
  ['Chin-Up',                    'Back',       B],
  ['Assisted Pull-Up Machine',   'Back',       W],
  ['Face Pull',                  'Back',       W],

  // Shoulders
  ['Overhead Press',             'Shoulders',  W],
  ['Dumbbell Shoulder Press',    'Shoulders',  W],
  ['Shoulder Press Machine',     'Shoulders',  W],
  ['Lateral Raise',              'Shoulders',  W],
  ['Cable Lateral Raise',        'Shoulders',  W],
  ['Rear Delt Fly',              'Shoulders',  W],
  ['Front Raise',                'Shoulders',  W],
  ['Shrug',                      'Shoulders',  W],

  // Quads
  ['Back Squat',                 'Quads',      W],
  ['Front Squat',                'Quads',      W],
  ['Smith Machine Squat',        'Quads',      W],
  ['Goblet Squat',               'Quads',      W],
  ['Leg Press',                  'Quads',      W],
  ['Hack Squat',                 'Quads',      W],
  ['Leg Extension',              'Quads',      W],
  ['Bulgarian Split Squat',      'Quads',      W],
  ['Walking Lunge',              'Quads',      W],

  // Hamstrings
  ['Romanian Deadlift',          'Hamstrings', W],
  ['Lying Leg Curl',             'Hamstrings', W],
  ['Seated Leg Curl',            'Hamstrings', W],
  ['Good Morning',               'Hamstrings', W],

  // Glutes
  ['Hip Thrust',                 'Glutes',     W],
  ['Glute Bridge',               'Glutes',     W],
  ['Cable Kickback',             'Glutes',     W],
  ['Hip Abduction Machine',      'Glutes',     W],

  // Calves
  ['Standing Calf Raise',        'Calves',     W],
  ['Seated Calf Raise',          'Calves',     W],
  ['Calf Press',                 'Calves',     W],

  // Biceps
  ['Barbell Curl',               'Biceps',     W],
  ['Dumbbell Curl',              'Biceps',     W],
  ['Hammer Curl',                'Biceps',     W],
  ['Preacher Curl',              'Biceps',     W],
  ['Cable Curl',                 'Biceps',     W],

  // Triceps
  ['Close-Grip Bench Press',     'Triceps',    W],
  ['Tricep Pushdown',            'Triceps',    W],
  ['Overhead Tricep Extension',  'Triceps',    W],
  ['Skullcrusher',               'Triceps',    W],
  ['Dip',                        'Triceps',    B],
  ['Assisted Dip Machine',       'Triceps',    W],

  // Core
  ['Hanging Leg Raise',          'Core',       B],
  ['Cable Crunch',               'Core',       W],
  ['Ab Wheel',                   'Core',       B],
  ['Plank',                      'Core',       T],
  ['Farmer Carry',               'Core',       T],
];
