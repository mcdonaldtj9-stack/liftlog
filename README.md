# LiftLog

A workout and bodyweight tracker built as an installable PWA, for one person, on one iPhone.

Live at **https://mcdonaldtj9-stack.github.io/liftlog/**

## Why it exists

Off-the-shelf apps gate custom exercises behind a paywall, have no RPE field, and
assume you always train in the same place. This one doesn't.

## Design rules

- **Unlimited custom exercises.** No cap, no upsell.
- **RPE on every set.** 6–10 in half steps, optional so warmups skip it.
- **Gym-aware.** Detects which of your locations you're at and defaults to what
  you normally do there. Never blocks the start of a workout waiting on GPS.
- **Local-first.** Every set is written to IndexedDB the instant you tap. Sync to
  Supabase happens in the background. The app works with no signal and no server.
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
3. Places + auto-detect
4. Supabase schema, auth, sync queue
5. Bodyweight + weigh-in nudge
6. History, PRs / estimated 1RM, volume charts

## Notes

- Paths are relative throughout — GitHub Pages serves this from `/liftlog/`, not root.
- Auth is email + password on purpose: magic links open in Safari, and an installed
  iOS home-screen app has separate storage from Safari, so the session would land
  in the wrong place.
- Bump `CACHE` in `sw.js` and `BUILD` in `js/app.js` on every deploy.
