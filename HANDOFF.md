# Handoff

For a fresh session continuing the lap timer. Read this, then `lap-timer-development-plan.md`
(§7 phases) and `NOTES.md` (where the code differs from the plan, and why).

## Where we are (2026-10-13)

- **Phases 0–4 are done, green and deployed** to https://timing-app-mj.web.app (Firebase Hosting,
  project `timing-app-mj`).
- **Next: Phase 5, PWA hardening & polish** (plan §7). Not started.

## Phase 4 commits (all on `main`, pushed)

| Commit | Feature |
|---|---|
| 94cb7ce | Route history page: sessions, bests, theoretical best, sector table |
| ab17527 | Run detail and comparison: sectors, gap/speed charts (uPlot), coloured trace map |
| d9b2e4c | Live reference choice (best / session best / pinned run), schema v2 |
| ffdf96b | Export GPX/CSV, backup/restore (fflate + Zod) |

## Phase 5 plan (next steps, in order)

1. **Service worker + install**: `vite-plugin-pwa` (Workbox), precache the app shell, web app
   manifest and icons, an install prompt. Runtime-cache OpenFreeMap tiles/styles (stale-while-
   revalidate, capped) so saved routes' maps work offline. Firebase serves `index.html` with
   `no-cache` already (firebase.json); keep `sw.js` uncached too.
2. **Persistent storage**: ask with `navigator.storage.persist()` on first save, not only from the
   Settings button (`requestPersistentStorage` in `src/data/db.ts`).
3. **Bundle**: lazy-load the map/editor/analysis pages (main chunk is ~1.8 MB, mostly MapLibre).
4. **Themes**: `Settings.theme` ('dark' | 'light' | 'sunlight') exists but is not applied yet.
   Sunlight = maximum contrast for the live screen outdoors.
5. **Landscape layout** for the live screen; **accessibility** pass; **onboarding** (first-run
   explanation, GPS permission, the closed-roads disclaimer as an explicit acknowledgement).
6. **Error monitoring**: the plan says Sentry with coordinates stripped. There is no Sentry DSN,
   so build a small reporter with a scrub step (lat/lon removed) that can take a DSN later, and a
   local error log viewable in Settings.
7. Deploy, record the URL + date in NOTES.md "Deploys", refresh this file.

## Working rules (agreed with the managing session)

- Test every feature (unit/component + Playwright e2e for user flows). Before each commit:
  `npm run typecheck && npm test && npm run lint && npm run e2e`. Never commit red.
- Commit each feature separately on `main` and `git push`. `dist/`, `test-results/` and
  `*.tsbuildinfo` are git-ignored.
- After each phase: `npm run build && npx firebase deploy --only hosting`, check the Hosting URL,
  record it in NOTES.md.

## Known issues / notes

- The drive e2e (`e2e/drive.spec.ts`) is one long flow (import → drive → history → run → pin);
  it has its own 90 s timeout and takes ~30 s.
- uPlot calls `matchMedia` when imported; component tests that import charts stub it
  (see `src/features/analysis/RunView.test.tsx`).
- Field tests (Phase 0 logs, Phase 3 exit criteria) are still the user's to do; see NOTES.md
  "Things to settle with Phase 0 data".

## Verify

```
npm ci
npx playwright install chromium   # once
npm run typecheck && npm test && npm run lint && npm run e2e
npm run dev                       # http://localhost:5173
```
