# LiftLog

A workout and bodyweight tracker built as an installable PWA, for one person, on one iPhone.

Live at **https://mcdonaldtj9-stack.github.io/liftlog/**

## Why it exists

Off-the-shelf apps gate custom exercises behind a paywall, have no RPE field, and
assume you always train in the same place. This one doesn't.

## Design rules

- **Unlimited custom exercises.** No cap, no upsell.
- **Routines.** Group exercises into the days you actually run — Push, Pull,
  Legs. A routine can belong to a gym, so the Planet Fitness version and the
  garage version live side by side under the same name. Finish a session and
  save it as a routine rather than building one by hand — targets are inferred
  from what you actually did.
- **Weight suggestions.** Give an exercise a target rep count and it suggests a
  load from your recent estimated 1RM (RPE-aware Epley, 60-day window, ~2 reps
  in reserve). Always offered as a tap, never prefilled — the weight box still
  shows what you actually lifted last time.
- **RPE on every set.** 6–10 in half steps, optional so warmups skip it.
- **Gym-aware.** Notes you write against an exercise come back the next time you
  do it at that same gym. Location is picked by hand today; GPS auto-detect is
  next, and will never block the start of a workout waiting on a fix.
- **Rest timer** storing an absolute deadline, so locking the phone doesn't stop
  it. Beeps on finish. iOS has no vibration API for web apps, so a notification
  (system sound + haptic) is the closest substitute and is opt-in.
- **Local-first.** Every set is written to IndexedDB the instant you tap. Sync to
  Supabase runs in the background and never blocks a tap. The app works fully
  with no signal, no server, and no account. A pull never overwrites work that
  hasn't been uploaded yet — what you did on the phone wins, and the next push
  settles it.
- **Bodyweight that corrects for your scales.** Readings remember which scale
  they came from. Each scale's bias against your most-used one is measured from
  weigh-ins taken close together (the median, so one post-dinner reading can't
  skew it) and removed before the trend is drawn — so alternating between two
  scales that disagree by 2 lbs doesn't turn into a sawtooth. The headline is
  the smoothed trend and its change over four weeks, never the latest raw number.
- **Catches typos.** Before a set is written, an outlier weight (over 5% *and*
  at least 10 lbs above your last working set) or an implausible rep count asks
  you to confirm the actual numbers. Warmups, drop sets and failed attempts are
  excluded from the baseline so it only fires on genuine outliers.
- **Fast between sets.** Weight and reps prefill from last time, big tap targets,
  no keyboard unless you want one.

## Setting up sync

Four steps in the Supabase dashboard, then two values into the app. No
credentials live in this repo.

1. **SQL Editor** → paste `supabase/schema.sql` → **Run**. Creates the tables,
   the server-side timestamps sync pages through, and row level security.
2. **Authentication → Providers → Email** → turn OFF *Allow new users to sign
   up*. The anon key is public, so this is half the security model.
3. **Authentication → Users → Add user** → your email and a password, with
   auto-confirm on. This is the only account that will ever exist.
4. **Project Settings → API Keys** → copy the **publishable** key (older
   projects call it the **anon** key) and the project URL into the app under
   Settings → Sync, then sign in with the user from step 3. Never the secret
   or `service_role` key.

The publishable key is designed to be public in a browser app. What actually protects
the data is RLS: every row carries a `user_id` and every policy requires it to
match the signed-in user. With signups disabled, nobody else can obtain a user.

Sign-in is email and password rather than a magic link on purpose: a magic link
opens in Safari, and an installed iOS home-screen app has separate storage, so
the session would land somewhere the app can't see it.

## Stack

Vanilla HTML/CSS/JS, no build step. IndexedDB locally, Supabase (Postgres) for
sync. Hosted on GitHub Pages.

## Development

No build step — the app is plain files. Node is only used for checks:

```
npm install      # once, for the test's fake IndexedDB
npm test         # data-layer tests against a real IndexedDB implementation
npm run check    # syntax-check every script before pushing
npm run serve    # http://127.0.0.1:8732
```

`npm test` is the only safety net that runs off-device, so anything where a
silent data bug would cost a logged workout belongs in it.

## Build order

1. ✅ App shell, manifest, service worker, deploy
2. ✅ Exercises + set logging with RPE (local only)
3. ✅ Rest timer, drop sets, failed sets, per-exercise notes, manual locations
   plus a confirmation step on outlier weights and rep counts
4. ✅ Routines with per-exercise targets, optionally per location,
   plus 1RM-based weight suggestions
5. GPS auto-detect for locations
6. ✅ Supabase schema, auth, background sync
7. ✅ Bodyweight with per-scale correction, trend, and weigh-in nudge
8. History, PRs / estimated 1RM, volume charts
9. Export to a file (the other half of "not only on the phone")

## Notes

- Paths are relative throughout — GitHub Pages serves this from `/liftlog/`, not root.
- Auth is email + password on purpose: magic links open in Safari, and an installed
  iOS home-screen app has separate storage from Safari, so the session would land
  in the wrong place.
- Bump `CACHE` in `sw.js` and `BUILD` in `js/app.js` on every deploy.
