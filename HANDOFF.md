# Handoff

For a fresh session continuing the lap timer. Read this, then `lap-timer-development-plan.md`
(§7 phases) and `NOTES.md` (where the code differs from the plan, and why).

## Where we are (2026-10-13)

- **Phases 0–5 are done, green and deployed** to https://timing-app-mj.web.app (Firebase Hosting,
  project `timing-app-mj`). That is the plan's **MVP**.
- **Still open from the plan:** the field tests (Phase 0 GPS logs on the target phones, the Phase 3
  exit criteria: a flying-start circuit and a standing-start stage, driven for real). Only the user
  can do these. Their results may change thresholds (see NOTES.md "Things to settle with Phase 0
  data").
- **Next, if asked:** Phase 6+ optional extensions (plan §7): accounts and sync (Supabase), shared
  routes and leaderboards, external Bluetooth GPS, Capacitor, accelerometer launch detection,
  hands-free countdown, OSM raceway picker, video overlay. None started; pick with the user.

## Commits

Phase 4: 94cb7ce history · ab17527 run detail/compare · d9b2e4c reference choice (schema v2) ·
ffdf96b export + backup · a7b5ca0 notes/deploy.

Phase 5:

| Commit | Feature |
|---|---|
| 0a223e9 | Installable offline PWA: service worker, manifest, icons, tile cache, persistent storage |
| 0cdd95b | Lazy-load map and chart pages (first load 1.85 MB → 416 kB) |
| 09700d6 | Dark / light / sunlight themes; landscape live screen |
| 2cc8953 | First-run onboarding with the closed-roads acknowledgement |
| 88eae34 | Accessibility pass: axe-core e2e in all themes, contrast fixes |
| 95f1645 | Error monitoring: local scrubbed error log; Sentry only with `VITE_SENTRY_DSN` |

## Working rules (agreed with the managing session)

- Test every feature (unit/component + Playwright e2e for user flows). Before each commit:
  `npm run typecheck && npm test && npm run lint && npm run e2e`. Never commit red.
- Commit each feature separately on `main` and `git push`. `dist/`, `test-results/` and
  `*.tsbuildinfo` are git-ignored.
- After each phase: `npm run build && npx firebase deploy --only hosting`, check the Hosting URL,
  record it in NOTES.md "Deploys", refresh this file.

## Known issues / notes

- No Sentry DSN is configured, so errors are only logged on the device (Settings → Error log).
  To turn on Sentry: build with `VITE_SENTRY_DSN=<dsn> npm run build`.
- The e2e suite starts two servers (dev on 5199, production preview on 5198). The preview server
  runs `vite build` first; `reuseExistingServer` is on outside CI, so stop a stale preview server
  if a build change doesn't show up in `e2e/pwa.spec.ts`.
- The drive e2e is one long flow (~30 s) with its own 90 s timeout.
- uPlot calls `matchMedia` on import; component tests that import charts stub it.
- e2e fixtures pre-accept onboarding (`onboarded: true`); use `test.use({ onboarded: false })` to
  test first-run behaviour.

## Verify

```
npm ci
npx playwright install chromium   # once
npm run typecheck && npm test && npm run lint && npm run e2e
npm run dev                       # http://localhost:5173
```
