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
  Supabase happens in the background. The app works with no signal and no server.
- **Catches typos.** Before a set is written, an outlier weight (over 5% *and*
  at least 10 lbs above your last working set) or an implausible rep count asks
  you to confirm the actual numbers. Warmups, drop sets and failed attempts are
  excluded from the baseline so it only fires on genuine outliers.
- **Fast between sets.** Weight and reps prefill from last time, big tap targets,
  no keyboard unless you want one.

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
6. Supabase schema, auth, sync queue
7. Bodyweight + weigh-in nudge
8. History, PRs / estimated 1RM, volume charts

## Notes

- Paths are relative throughout — GitHub Pages serves this from `/liftlog/`, not root.
- Auth is email + password on purpose: magic links open in Safari, and an installed
  iOS home-screen app has separate storage from Safari, so the session would land
  in the wrong place.
- Bump `CACHE` in `sw.js` and `BUILD` in `js/app.js` on every deploy.
