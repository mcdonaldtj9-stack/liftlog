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
  from what you actually did. Started from a routine and added an exercise on
  the day? Finishing offers to add it to that routine, targets inferred the same
  way, with nothing already in it touched.
- **Weight suggestions.** Give an exercise a target rep count and it suggests a
  load from your recent estimated 1RM (RPE-aware Epley, 60-day window, ~2 reps
  in reserve). Always offered as a tap, never prefilled — the weight box still
  shows what you actually lifted last time.
- **RPE on every set.** 6–10 in half steps, optional so warmups skip it.
- **Gym-aware.** Notes you write against an exercise come back the next time you
  do it at that same gym. Save each gym's spot once (Locations → Set to here) and starting a
  workout there picks it for you. Detection never blocks the start of a session,
  and never overrides a location you chose or a routine tied to a gym — it offers.
- **Rest timer** storing an absolute deadline, so locking the phone doesn't stop
  it. Beeps on finish. iOS has no vibration API for web apps, so a notification
  (system sound + haptic) is the closest substitute and is opt-in. The rest can
  be extended (+15s, +30s) or restarted at another length while it runs.
- **Rest alerts on the lock screen.** iOS suspends a web app's JavaScript when
  the screen locks, so the local timer can't ring there. With sync on, the app
  schedules the alert on the server instead: a cron job hands it to an edge
  function at the right second, which sends a Web Push the phone shows on the
  lock screen with the system sound. Skipping or extending the rest moves it.
  No web app can show a live countdown on the iOS lock screen; the arriving
  notification is what's possible. Server side is in `supabase/push.sql` and
  `supabase/functions/send-push/`.
- **Warmups are marked W**, and working sets count 1, 2, 3 on their own.
- **Numbers type over.** Tapping into a weight or rep field selects the whole
  value, so the first keystroke replaces it instead of appending to it.
- **Routines can be archived.** A finished programme leaves the list and waits
  under "Archived routines" until you restore it.
- **Scales are places too.** Weigh-ins are logged against the home scales
  (Fenton, Effingham), which are kept apart from the gyms: the Weight tab
  shows only the scales, the Train tab only the gyms.
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
- **A goal you can see.** Set a start weight and date and a goal weight and
  date (Settings → Weight goal) and the Weight tab draws the straight line
  between them with a ±2 lb tolerance band, editable, so a salty dinner doesn't
  read as falling off the plan. Everything is measured against the smoothed
  trend, never a raw reading: where the line says you should be, the
  difference, your real rate over the last 14 days, and the date that rate
  lands you on the goal. Two weeks under 0.25 lb/week is flagged as stalled;
  over 1.5 lb/week as too fast. The goal syncs and backs up with everything
  else.
- **Tells you when to go up.** If last session hit every target set at RPE 8
  or lower, the next one offers +5 lbs (+2.5 on light work). No RPE, no
  suggestion: without it there's no telling "easy" from "ground out".
- **Marks records as they happen.** A working set that beats your all-time best
  for that many reps, or your best estimated 1RM, says so on the spot — once
  there are a few sessions to beat, so it doesn't cry wolf in week one.
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
   (Optional, for lock-screen rest alerts: run `supabase/push.sql` too, deploy
   `supabase/functions/send-push`, and put four secrets in Vault — see the
   header of `push.sql`. A VAPID pair comes from
   `node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(async k=>console.log(JSON.stringify({publicKey:await crypto.subtle.exportKey('jwk',k.publicKey),privateKey:await crypto.subtle.exportKey('jwk',k.privateKey)})))"`.)
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
5. ✅ GPS gym detection: save each gym once, then sessions pick it up
6. ✅ Supabase schema, auth, background sync
7. ✅ Bodyweight with per-scale correction, trend, and weigh-in nudge
8. ✅ History: weekly sets by region, per-exercise strength trend, rep maxes, sessions
9. ✅ Backup, restore and spreadsheet export
10. ✅ Exercise editing, set correction, progression prompts, PRs, rest per exercise
11. ✅ Weight goal: goal line, tolerance band, pace and projection, synced settings
12. ✅ Lock-screen rest alerts by Web Push; adjustable rests; W for warmups;
    type-over numbers; archived routines; home scales for weigh-ins

## Notes

- Paths are relative throughout — GitHub Pages serves this from `/liftlog/`, not root.
- Auth is email + password on purpose: magic links open in Safari, and an installed
  iOS home-screen app has separate storage from Safari, so the session would land
  in the wrong place.
- Bump `CACHE` in `sw.js` and `BUILD` in `js/app.js` on every deploy.
