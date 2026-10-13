# Build notes

Working notes alongside `lap-timer-development-plan.md`: what's built, where the code differs from
the plan, and the measured gaps you should know about.

## Status (2026-10-13)

| Phase | State |
|---|---|
| Phase 0: GPS logger | **built**: "GPS logger" page (`src/features/gps-logger`). Needs your field drives. |
| Phase 1: timing engine + test harness | **built and tested** (`src/engine`, `src/gps/simulator.ts`, `tests/`) |
| Phase 2: routes & map | **built and tested**: app shell, Dexie, settings, map, route editor, GPX, record-a-route, recompute worker |
| Phase 3: arm, countdown & live timing | **built and tested**: drive screen (arm → countdown → live → result → history), beeps, voice, vibration. **Field test pending (yours).** |
| Phase 4: history & analysis | **built and tested**: history per session/start mode, run detail, charts, coloured trace, reference choice, compare, GPX/CSV export, backup/restore |
| Phase 5: PWA hardening & polish | **built, tested and deployed**: offline PWA, install, tile cache, lazy loading, themes, landscape, onboarding, accessibility, error log. **MVP done** (field tests pending) |
| Phase 6+ | optional extensions, not started |

Checks: `npm run typecheck && npm test && npm run lint`, `npm run coverage` (pure logic > 90%),
and `npm run e2e` (Playwright; needs `npx playwright install chromium` once). The e2e run starts
two servers: the dev server, and a production build on `vite preview` for the service worker tests.
Run the app with `npm run dev`. Geolocation needs HTTPS or `localhost`.

## Deploys

Firebase Hosting, project `timing-app-mj`: `npm run build && npx firebase deploy --only hosting`.

| Date | Phase | URL |
|---|---|---|
| 2026-10-13 | Phases 0–3 | https://timing-app-mj.web.app |
| 2026-10-13 | Phase 4 (commit ffdf96b) | https://timing-app-mj.web.app |
| 2026-10-13 | Phase 5 (commit 95f1645) | https://timing-app-mj.web.app |

## Differences from the plan

1. **Projection constants (§4.1).** The plan's `111 320` / `110 540` m/° are equator values. At
   50° N they make north–south distances ~0.6% short. `createProjection` now uses the WGS84
   metres-per-degree at the route's own latitude. Same formula shape, same cost.
2. **Remainder rule example (§4.2).** The rule says "merge the last sector if it is shorter than
   I/2". The plan's 500 m example (2 330 m → 3 × 500 + 830) contradicts that: the remainder of
   330 m is not < 250 m. The code follows the stated rule (→ 4 × 500 + 330). If you want
   "always merge the remainder", change the `mergeBelow` argument of `computeCheckpoints` to 1.
3. **Along-track smoothing is in Phase 1, not "later" (§4.3 C).** Without it, the accuracy target
   failed (p95 total 274 ms on a stage, 309 ms on a circuit). `engine/smoothing.ts` integrates
   Doppler speed and low-passes only the position offset. It is causal, so live timing has no
   delay. It can be turned off with `smoothing: null`.
4. **Jump-start detection (§4.4 step 6), tightened after the benchmark.** With the plan's literal
   rule (one fix > 3 m forward), 10–35% of simulated *stationary* cars were flagged. Now:
   - the reference position is the median of the last 10 staged fixes, not 3;
   - the distance trigger needs 2 consecutive fixes, and the device speed must agree (> 1 m/s)
     when it is reported;
   - plus a launch-time check, below.
5. **Launch time / late detection.** At 1 Hz, a car leaving 1 s early often logs no fast fix
   before zero (caught only 10% of the time with the rules above). The launch moment is now
   estimated by extrapolating Doppler speed back to v = 0 from two moving fixes. A launch ≥ 0.3 s
   before zero is flagged as a jump start, even if that is only spotted just after zero.
6. **Circuit lap fallback.** If the fixes miss the 40 m gate (fast chord across a corner at the
   line, outlier fix), the lap now ends where the distance along the route passes L. Stages had
   this already, via a 200 m lead-out.

### Phase 2

7. **Stored route geometry is the editable vertices, not the 5 m resample (§4.9).** Editing a
   line with hundreds of 5 m points is unusable. The engine resamples on load, which is cheap.
8. **GPX parsing runs on the main thread, not in a worker (§10).** Workers have no `DOMParser`,
   which togeojson needs, and GPX files are small.
9. **MapLibre directly, without react-map-gl (§9.2).** Terra Draw needs the raw map instance
   anyway; one less layer.
10. **Native range + number input instead of the shadcn slider; no shadcn yet.** Tailwind only,
    with accessible labels. Swapping in shadcn later is cosmetic.
11. **Start/finish gates sit at the ends of the line, with a "Reverse direction" button.** The plan
    mentions draggable gate handles (§10). To move a gate today, edit the line's end points.
12. **Snap to roads needs an OpenRouteService key entered in Settings.** A public PWA can't keep
    a key secret, so none is built in.
13. **Bundle size.** The main chunk is ~1.7 MB (mostly MapLibre). Lazy-loading the map/editor is a
    Phase 5 item.

What is tested how (Phase 2): the editor is a pure reducer (45 tests); preview/gates, GPX (12
fixture files), snap-to-roads (mocked fetch), record-a-route (simulated drives replayed), and the
recompute worker (handler = main thread, across a real MessageChannel) are unit-tested; Dexie runs
on fake-indexeddb. MapView.tsx is a thin adapter with no unit tests: drawing with the mouse is
**not** covered by an automated test yet. The Playwright smoke test covers import → slider →
save → reload, and fails on any console error, which caught a real MapLibre worker-loading bug.

### Phase 3

14. **Flying start: direction by progress, plus a fallback (§4.3 A).** A property test found that
    at low speed (8 m/s, 3.5 m noise) the bearing of the single segment crossing the start line is
    often > 60° off, so the start was never detected and **the whole run was lost**. The start now
    counts if the car's position along the route moved forward across the line. If the fixes pass
    outside the 40 m gate, it starts where the distance along the route crosses 0. The 2-fix
    forward-progress confirmation is unchanged; wrong-way crossings are still rejected.
15. **Audio/vibration/speech are injected into the timing session.** Tests record them instead
    of playing them. Countdown beeps are scheduled on the Web Audio clock at START (iOS needs that
    tap to allow sound).
16. **History on the drive screen is a simple list for now.** The full history and analysis
    screens are Phase 4.
17. **`?gps=test` (dev server only)** swaps the device GPS for a source the e2e test pushes
    fixes into. Production builds don't include it.

Testing (Phase 3): the live view model (24 tests) and the session controller (7) run against the
real tracker with a fake clock, pushed GPS fixes and fake-indexeddb; the drive screen has 3
component tests on top of a real session; e2e/drive.spec.ts does arm → countdown → GPS → saved →
history with Playwright's fake clock. Not covered automatically: real sound output, vibration,
the wake lock, and behaviour with the screen locked. Those need the field test.

### Phase 4

18. **Compare = run detail with `?vs=`.** "Compare two runs" opens `/runs/<a>?vs=<b>`: the sector table
    puts both side by side, with the gap chart, both speed traces and the map. One page instead of
    two.
19. **Reference choice is a new table (schema v2, `referenceChoices`).** Per route and start mode:
    best ever (default), best this session, or a pinned run. A pinned run stays the reference even
    when a faster run comes in; deleting it falls back to "best". Set it on the history page or with
    "Pin as live reference" on a run.
20. **Trace colours show where time is won or lost**, not the cumulative gap: each segment's change
    in gap per 100 m (green = gaining, red = losing). The cumulative gap is the chart above it.
    Without a reference, the trace is coloured by speed.
21. **Backups are gzip-compressed JSON (fflate)**, `laptimer-backup-<date>.json.gz`; restore also
    accepts plain JSON. Zod validates the file before anything is written; restore can merge (by
    id) or replace, in one transaction. The OpenRouteService key is never written to a backup.
22. **No TanStack Table.** The history and sector tables are plain tables; there is no sorting or
    filtering need yet.

Testing (Phase 4): history model, analysis maths, exporters (GPX round-trips through the
importer) and backup (round trip into an empty DB, merge vs replace, bad files) are unit-tested;
HistoryView and RunView have component tests; e2e covers drive → history → run detail → pin as
reference → arm screen, and backup → delete → restore. Charts (uPlot) and the trace map are thin
adapters, checked only by the e2e (they render without errors).

### Phase 5

23. **Updates wait for the user.** The service worker uses `registerType: 'prompt'` without
    `clientsClaim`: a new version shows a "Reload" banner (never on the drive screen) instead of
    reloading by itself, which could end a run. The first visit is served by the network and the
    next one by the worker.
24. **Map tiles are cached as they are viewed** (CacheFirst, 3000 tiles, 30 days). There is no
    "download this area" button: open a route's map once while online and it works offline.
25. **Themes redefine Tailwind's neutral scale** (index.css) instead of styling each component.
    Sunlight = pure black on white with heavier text. In the light themes only amber *text* is
    darkened; amber buttons stay bright with black text (axe-core found the darker amber failed
    contrast as a button background).
26. **The safety acknowledgement is per device** (localStorage), not in the backup: it is about
    whoever holds that phone. It gates the whole app on first run, including deep links.
27. **Error monitoring without a Sentry account.** Errors go to a local log (Settings → Error log,
    copyable for bug reports) with coordinates scrubbed. Sentry is wired but only loads when the
    build sets `VITE_SENTRY_DSN`; otherwise it isn't bundled at all.
28. **Icons are generated by `scripts/make-icons.mjs`** (no image dependencies; rerun it to change
    them).
29. **Bundle:** the first load is 416 kB (130 kB gzipped). MapLibre (1.2 MB) and uPlot load only with
    the editor, record and run pages.

Testing (Phase 5): e2e against the production build checks the manifest and icons, an offline
reload and an offline deep link; axe-core scans the main screens in all three themes and the welcome
screen (WCAG 2.1 AA, no serious/critical findings); onboarding, theme switching and the error log
have e2e tests; the scrubber, the error log, the theme and the PWA banner have unit/component tests.
Not automated: the real install prompt, iOS behaviour, and how the themes read in actual sunlight.

## Measured accuracy (simulator, 1 Hz, seeded; `tests/accuracy.test.ts`)

Noise σ is per axis. "White" = independent per fix; ρ = correlation between consecutive fixes
(real GPS error wanders slowly, which is closer to ρ 0.9).

| Case | p95 total | p95 checkpoint | Plan target |
|---|---|---|---|
| Stage, flying, σ 3 m white | 127 ms | 146 ms | < 200 / < 300 ✅ |
| Circuit, σ 3 m white | 148 ms | 146 ms | ✅ |
| Stage, standing, σ 3 m white | 100 ms | 105 ms | ✅ (but 8% never stage: see below) |
| Stage, flying, σ 3 m ρ 0.9 | 285 ms | 290 ms | ❌ total |
| Circuit, σ 3 m ρ 0.9 | 263 ms | 282 ms | ❌ total |
| **Stage, standing, σ 3 m ρ 0.9** | **214 ms** | **247 ms** | **❌ total (test allows < 300)** |

### The open gap: slow-wandering GPS error

The plan's 0.2 s total-time target is met with independent (white) noise. It is **not** met when
the error wanders slowly (ρ 0.9), in **any** start mode. Averaging can't remove an error that
stays the same for several seconds, so no software filter fixes this. It is a property of the
GPS.

The standing-start test asserts `< 300 ms` rather than the plan's `< 200 ms` because of this gap.
It is not a standing-start defect. Under the **same** noise, standing is more accurate than
flying, as the plan predicts (the start comes from the clock):

| Same noise | Flying total p95 | Standing total p95 |
|---|---|---|
| σ 3 m white | 127 ms | 100 ms |
| σ 2.1 m white | 91 ms | 75 ms |
| σ 3 m ρ 0.9 | 285 ms | 214 ms |

The standing test uses correlated noise only because white noise at a standstill can't pass the
"spread < 3 m over 3 fixes" staging check (8% of white-noise runs never stage). Real stationary
GPS doesn't behave like that, so the correlated model is the realistic one for standing starts.

**What decides it:** Phase 0 logs from your phones. Measure how much the error wanders while
stationary and while driving a known loop. If real error is close to white, the target holds. If
it wanders like ρ 0.9, ±0.3 s is the realistic total-time accuracy with phone GPS, and the plan's
fallbacks apply (external 10 Hz GPS, R1).

### Jump starts (σ 3 m ρ 0.9, 4 m/s² launch, `tests/accuracy.test.ts`)

- No false jump starts in 600 simulated stationary waits (σ 2.1 m white, 3 m ρ 0.9, 5 m ρ 0.95).
- Launch ≥ 0.5 s before zero: always flagged. 0.25 s early: ~50% flagged (inside GPS
  uncertainty).
- Launch exactly at zero: ~1% falsely flagged. Real drivers react after zero (≥ 0.15 s), and the
  default is warn-only, so this is acceptable, but watch it in field tests.
- Launch-time error p5–p95: −170 … +90 ms.

## Things to settle with Phase 0 data

- The noise model above (white vs. wandering).
- Clock offset `receivedAt − fix.timestamp` per phone. Correction is off by default
  (`clockOffsetCorrection`). The offset is logged on every standing run.
- Whether phones report Doppler `speed` reliably (iOS sometimes gives `null` at low speed). Without
  it, smoothing and the launch estimate fall back to the coarser position-only rules.
