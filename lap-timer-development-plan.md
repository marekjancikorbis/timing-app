# Lap Time Tracker: Analysis & Development Plan

*Draft 2 · 2026-10-12*

**Changes from draft 1:**
- Sector distance is adjustable from 100 to 1000 m.
- New **standing start mode** with an adjustable countdown (3–10 s).
- New **technology stack** section, covering the whole project and each feature (§9, §10).

A web app where you pick a **circuit (lap)** or a **point-to-point road (rally stage)** on a map, arm the timer, and drive. The app:

- starts timing either when you cross the start line (**flying start**) or when a countdown ends (**standing start**),
- splits the route into **sectors of an adjustable length (100–1000 m)**,
- shows a **live delta** to your best run,
- saves routes, and saves every run/lap with its sector times.

---

## 1. Summary

| Topic | Recommendation |
|---|---|
| App type | **PWA** (installable web app) that works offline first |
| Language | TypeScript (strict) everywhere |
| Frontend | React 19 + Vite, TanStack Router, Zustand, Tailwind CSS + shadcn/ui |
| Map | MapLibre GL JS + Terra Draw (route drawing and editing) |
| Geometry | Turf.js for setup work, plus a small custom planar-math module for the timing hot path |
| Local storage | IndexedDB via Dexie.js (source of truth on the device) |
| Backend (later) | Supabase (Postgres + PostGIS + Auth + Storage) |
| Hosting | Cloudflare Pages (HTTPS is required for geolocation) |
| Testing | Vitest + fast-check + Playwright, and a **GPS replay/simulator** |
| Biggest risk | Phone GPS in a browser updates ~1×/s with 3–10 m error, and stops when the screen is off. **Prove this works on your phones in week 1.** |

The most important design decision: **keep the timing engine pure TypeScript with no browser or UI dependencies.** That keeps it testable with recorded data, and you can reuse it unchanged if you later wrap the app in Capacitor (a native shell) or add an external GPS.

---

## 2. Feasibility analysis

### 2.1 What browser GPS gives you

`navigator.geolocation.watchPosition()` with `enableHighAccuracy: true`:

| Property | Typical value | Impact |
|---|---|---|
| Update rate | **~1 Hz** on iOS and Android | At 100 km/h you get one fix every ~28 m. Without interpolation, a 100 m sector holds only 3–4 fixes. |
| Horizontal accuracy | 3–5 m open sky; 10–30 m in forest, valleys, near buildings | Rally stages are often in forests, so expect degraded data |
| `coords.speed` / `heading` | Often available, sometimes `null` | Use when present; otherwise derive from consecutive fixes |
| Timestamp | `position.timestamp` (ms epoch) | Use this, not the time the callback arrives. For standing starts, check how it relates to the system clock (§4.4). |
| Background | **Stops or is throttled when the screen is off or another app is in front** (especially iOS) | Keep the screen on with the **Screen Wake Lock API** and a phone mount |
| Secure context | HTTPS only | Dev on `localhost`; deploy with TLS |

### 2.2 How accurate the timing can be

Crossing times are interpolated between fixes (see §4.3), so resolution is not limited to 1 s. The real limit is **position error ÷ speed**:

| Speed | 3 m error | 5 m error | 10 m error |
|---|---|---|---|
| 30 km/h (hairpin) | ±0.36 s | ±0.60 s | ±1.2 s |
| 80 km/h | ±0.14 s | ±0.23 s | ±0.45 s |
| 150 km/h | ±0.07 s | ±0.12 s | ±0.24 s |

What this means:

- **Total lap/stage time** should be accurate to roughly ±0.1–0.3 s. That is good enough for personal improvement, not for official timing.
- **Standing-start total time** can be a little more accurate. The start moment comes from the device clock, so it has **no GPS error**. Only the finish crossing carries GPS error.
- **Short sectors are noisy, long sectors are stable.** The checkpoint error is about the same size whatever the sector length, so as a share of the sector time:
  - 100 m sectors: about ±5–10% of sector time,
  - 500 m sectors: about ±1–2%,
  - 1000 m sectors: under 1%.
  The adjustable interval (100–1000 m) lets you choose between detail and stability. Suggested defaults: 100–200 m for short circuits, 250–500 m for long stages.
- The UI should focus on the **cumulative gap** (where you are vs. your best at the same point). It is more stable than a single sector's time.

### 2.3 Web app vs. native

| | PWA (recommended start) | Native / Capacitor (later, if needed) |
|---|---|---|
| Distribution | Just a URL, nothing to install | App stores |
| Background tracking | ✗ needs screen on | ✓ |
| External 10–25 Hz GPS (Bluetooth) | Android Chrome only (Web Bluetooth); not on iOS | ✓ everywhere |
| Iteration speed | Fastest | Slower |

**Plan:** build a PWA with a clean `GpsSource` interface. If week-1 field tests show phone GPS isn't good enough, add Web Bluetooth GPS on Android or wrap the app in Capacitor. The engine and UI stay the same.

---

## 3. Functional scope

### 3.1 Core concepts

- **Route**: a saved path. Either:
  - `circuit`: a closed loop; the start line is also the finish line; you drive multiple laps.
  - `stage`: point-to-point, with separate start and finish lines; one run = one pass.
- **Sector interval**: the sector length for the route, **100–1000 m in 50 m steps** (default 100 m). You can change it at any time; existing runs are recomputed from their saved traces (§4.2).
- **Checkpoint**: a point every *interval* metres along the route, generated automatically.
- **Sector**: the stretch between two consecutive checkpoints (the start and finish lines count as checkpoints).
- **Start mode**:
  - `flying`: the timer starts when you cross the start line moving.
  - `standing`: you wait stationary at the start line, a **countdown of 3–10 s** (default 5 s) runs, and the timer starts at zero.
- **Session**: one outing on one route (e.g. a track day). It contains runs.
- **Run / Lap**: one timed pass from start to finish, with its sector times, start mode and full GPS trace.

### 3.2 Features by priority

**MVP (must have)**
1. Create a route on the map:
   - **Stage:** click a start and a finish (plus optional via-points) and **snap to roads**. You can then edit the vertices by hand.
   - **Circuit:** draw it by hand, or **record it by driving one reference lap**.
   - Import a GPX file.
2. Set the sector interval (100–1000 m slider) and see a live preview of the checkpoints and the start/finish gates on the map.
3. Save, rename and delete routes. Each route stores a default start mode and countdown length.
4. Arm the timer and pick the start mode:
   - **Flying:** timing starts automatically at the start line.
   - **Standing:** the app checks you are stationary at the start line, then you start the countdown (3–10 s) with sound and visual lights. It detects jump starts.
5. Live screen: running time, a large live delta, the last sector's delta, a sector strip (green/red/purple), and speed.
6. Automatic finish (stage) or automatic lap split (circuit).
7. Save each run with total time, sector times, start mode and the GPS trace.
8. History per route: list of runs, best run per start mode, sector table.
9. Works offline once a route is saved.

**Should have**
- Theoretical best (the sum of your best sectors).
- Choose what to compare against: best ever, best this session, or a specific run.
- Audio callouts (beeps or speech) so you don't have to look at the screen.
- Run analysis: a chart of delta vs. distance, a chart of speed vs. distance, and the trace on the map coloured by delta.
- Compare two runs side by side.
- Session notes: car, tyres, weather, surface.
- Export runs as GPX/CSV; back up and restore all data.
- Launch time after the countdown (approximate at 1 Hz; better with the accelerometer).

**Could have (post-MVP)**
- User accounts and cloud sync.
- Shared routes and leaderboards.
- External Bluetooth GPS.
- Pick circuits straight from OpenStreetMap (`highway=raceway`).
- Native wrapper (Capacitor) for background tracking.
- Video overlay export.
- Hands-free countdown: it starts automatically after you've been stationary at the line for N seconds.

---

## 4. Technical design

### 4.1 Coordinate handling

For timing, convert lat/lon to a **local flat x/y grid in metres**, centred on the route's first point. A simple equirectangular projection is accurate enough for routes under ~50 km:

```
x = (lon - lon0) * cos(lat0) * 111_320
y = (lat - lat0) * 110_540
```

### 4.2 Route preprocessing and adjustable sectors

1. **Resample** the route line to uniform ~5 m spacing.
2. Compute the **cumulative distance** `s[i]` for every vertex, and the total length `L`.
3. **Checkpoints** at `s = k · I` for `k = 1 … floor(L/I)`, where **`I` is the route's interval (100–1000 m)**.
   - **Remainder rule:** if the last sector would be shorter than `I/2`, merge it into the previous one.
   - Example: `L` = 2,330 m with `I` = 500 m gives 3 × 500 m + 1 × 830 m. With `I` = 100 m it gives 22 × 100 m + 1 × 130 m.
   - **Edge case:** if `I ≥ L`, there is a single sector (start → finish). The UI should warn about this.
4. **Gates** for the start and finish:
   - A line segment perpendicular to the route at that point.
   - Default width is 40 m (configurable).
   - Store the route's bearing at the gate, used later to check you're driving the right way.
5. For a **stage**, add a virtual **200 m lead-in** straight behind the start line. Positions before the start then project to negative `s`.

**Changing the interval later:** checkpoint times are derived from each run's stored distance→time profile `(s_i, t_i)`. So when the interval changes:
- all runs on the route are **recomputed** (milliseconds per run),
- comparisons always use the same checkpoint positions,
- old runs are never thrown away.

`Run.sectorMs` is effectively a cache tied to `Run.intervalM`.

### 4.3 Timing algorithm

**A. Start/finish: gate-line crossing** (flying start, lap splits, stage finish)

For each new fix `p_i`:
- If the movement segment from `p_{i-1}` to `p_i` intersects the gate segment at fraction `f`, then:
  `t_cross = t_{i-1} + f · (t_i − t_{i-1})`
- **Direction check:** the direction of movement must be within ±60° of the route's bearing at the gate.
- **Jitter guard** (flying start): mark the crossing as *provisional*. Confirm it only if the next 2 fixes show forward progress of more than 10 m along the route. The confirmed start time is still the interpolated crossing time.
- **Circuit lap guard:** only count a crossing as a lap end if you've driven more than 50% of `L` since the last crossing and the lap time is above a minimum.

**B. Intermediate checkpoints: distance travelled along the route**

1. Project each fix onto the route line to get `s_i`, the distance along the route.
2. **Search only near the last known position**: in `[s_prev − 30 m, s_prev + max(v·Δt·2, 150 m)]`. This keeps the projection on the correct stretch of road at hairpins and on parallel straights.
3. When `s_{i-1} < D_k ≤ s_i`, interpolate:
   `t_k = t_{i-1} + (D_k − s_{i-1}) / (s_i − s_{i-1}) · (t_i − t_{i-1})`
4. Distance only ever counts forward.

**C. Fix filtering**
- Drop fixes with `accuracy > 25 m`. They are still logged, but flagged.
- Drop duplicate or out-of-order timestamps.
- Drop impossible jumps (implied speed above 300 km/h).
- *(Later)* Light Kalman smoothing.

**D. Off-route and GPS-loss handling**
- If the distance from the route line is above 50 m for 3 consecutive fixes, the run is **off-route**. Mark it invalid, or abort.
- **GPS gap under 5 s:** interpolate the skipped checkpoints and flag them `estimated`.
- **GPS gap over 15 s:** the run is saved but marked invalid.

### 4.4 Standing start with countdown

**Flow**

1. **Arm in standing mode.** The countdown length (3–10 s, 1 s steps) comes from the route's default; you can change it on the arm screen.
2. **Staging checks.** All must be true before the start button is enabled:
   - GPS accuracy ≤ 10 m,
   - the car is **within 0–20 m behind the start line** (`−20 ≤ s ≤ +2`; the +2 m tolerates GPS error),
   - the car is **stationary**: speed < 1 m/s and spread of positions < 3 m over the last 3 fixes.
3. **Start the countdown.** Tap a large "START" button. The car is stationary, so a tap is safe here. *(Hands-free auto-start is a post-MVP option.)*
4. **Countdown.**
   - Full-screen digits plus a rally-style row of lights.
   - A **short beep each second and a long beep at zero**. The beeps are scheduled ahead of time with the Web Audio API, so they land exactly on time; speech has too much delay for this.
   - Vibration as well on Android.
   - The audio system must be enabled during the "START" tap, because iOS blocks sound that isn't triggered by a tap.
5. **Zero means time 0.**
   - `t0` is taken from `performance.now()` (a steady clock that can't jump) and converted to wall-clock time with `performance.timeOrigin + t0`.
   - The running clock starts immediately, from the device clock, with no GPS involved.
6. **Jump-start detection.** During the countdown, keep watching the GPS. If the car moves more than 3 m forward, or its speed is above 2 m/s for 2 fixes:
   - flag `jumpStart`, with a warning on screen and an audio buzz,
   - the run continues but is **excluded from bests**, depending on a setting.
   - A thresholds tweak may be needed after Phase 0, because GPS drift while stationary must not trigger false jump starts.
7. **Launch time (optional).**
   - Measures the time from zero until the car starts moving.
   - From GPS alone it's coarse at 1 Hz, so it's shown as approximate.
   - It can be improved later with `DeviceMotionEvent` (accelerometer). iOS requires asking for permission.
8. **Cancel.** You can cancel the countdown at any time; the app returns to staged.

**Clock alignment (important)**

The start time `t0` comes from the **system clock**, but checkpoint and finish times come from **GPS fix timestamps**. If these two clocks disagree, every standing-start time is off by a constant.

- While staged, record `offset = receivedAt − fix.timestamp` for each fix and keep the median.
- Phase 0 measures this offset on each target phone:
  - If it is small and stable (the usual case: both are system time), no correction is needed.
  - Otherwise, convert fix times into system-clock time with the median offset.
- Log the offset with every standing-start run, so problems can be diagnosed.

**Circuits with standing start**
- Only **lap 1** uses the standing start. Lap 1 ends at the first start/finish crossing.
- Laps 2+ are flying laps.
- Lap 1 is stored with `startMode: 'standing'` and is **compared only against other standing-start lap 1s**. By default, all bests and deltas are grouped by start mode. They don't need grouping by countdown length, because the time always starts at zero.

### 4.5 Tracker state machine

```
                         ┌── flying ──▶ READY (valid fix, s<0) ──start crossed (confirmed)──┐
 IDLE ──arm──▶ ARMED ────┤                                                                 ▼
                         └── standing ─▶ STAGED ──tap START──▶ COUNTDOWN ──reaches 0──▶ RUNNING
                                          ▲  (stationary,        │   │ moved → flag jumpStart
                                          │   at line, GPS ok)   │   │ (continues)
                                          └──────cancel──────────┘   │
                                                                     ▼
            ┌───────────────────────── RUNNING ◀── lap split (circuit, flying) ──┐
            │                              │   └──────────────────────────────────┘
   off-route / user stop                   │ finish crossed (stage) / user stop (circuit)
            ▼                              ▼
         ABORTED                        FINISHED ──auto re-arm (optional)──▶ ARMED
```

### 4.6 Delta calculation

| Metric | Formula | Shown as |
|---|---|---|
| **Live gap** (continuous) | `t_cur(s) − t_ref(s)`, with the reference profile interpolated by binary search | Big number, updates with every fix |
| **Gap at checkpoint k** | `cum_cur[k] − cum_ref[k]` | Updates at every checkpoint |
| **Sector delta** | `sec_cur[k] − sec_ref[k]` | Sector strip colour |
| **Theoretical best** | `Σ min over valid runs (same start mode) of sec[k]` | History / analysis |

- The reference run defaults to the **best valid run with the same start mode**.
- Sector colours: purple = best ever, green = faster than reference, red = slower.
- The live gap is smoothed over ~1 s (configurable).

### 4.7 Architecture

```
┌──────────────────────────── Browser / PWA ────────────────────────────┐
│  UI (React + TanStack Router + Tailwind/shadcn)                        │
│   Routes · Route editor · Arm/Countdown/Live · History · Analysis     │
│        │                 ▲                                            │
│        ▼                 │ state (Zustand) / live queries (Dexie)     │
│  ┌──────────────┐   ┌──────────────────────────┐   ┌────────────────┐ │
│  │ GpsSource    │──▶│ Timing engine (pure TS)   │──▶│ Repositories   │ │
│  │ • browser    │   │ • geo / route / tracker   │   │ (Dexie /       │ │
│  │ • replay     │   │ • countdown / delta       │   │  IndexedDB)    │ │
│  │ • simulator  │   │ • filters                 │   └───────┬────────┘ │
│  │ • BT (later) │   └────────────┬─────────────┘           │ sync     │
│  └──────────────┘                │ events                  │ (later)  │
│                    ┌─────────────▼────────────┐            │          │
│                    │ Feedback: Web Audio,     │            │          │
│                    │ Speech, Vibration        │            │          │
│                    └──────────────────────────┘            │          │
│  Service worker (Workbox): app shell + tile cache           │          │
│  Web Worker (Comlink): bulk recompute, GPX parse, simplify  │          │
└─────────────────────────────────────────────────────────────┼──────────┘
                                                              ▼
                                       Supabase (Postgres + PostGIS + Auth + Storage)
External APIs (only for route creation): routing, geocoding, map tiles
```

- The engine gets the current time through an injected `Clock` interface. Tests can then fast-forward the countdown with a fake clock.
- The engine emits events (`countdownTick`, `start`, `checkpoint`, `lap`, `finish`, `jumpStart`, `offRoute`). The UI and the audio module subscribe to them.
- `navigator.geolocation` is only available on the main thread, so the engine runs there. That's fine: its work per fix is microseconds. Workers are used only for bulk jobs.
- Timing doesn't depend on map tiles or the network.

### 4.8 Suggested project structure

```
src/
  engine/              # pure TS, 100% unit-tested, no DOM
    geo.ts             # projection, distance, bearing, segment intersection
    route.ts           # resample, cumulative distance, checkpoints(interval), gates
    tracker.ts         # state machine, crossings, sector timing
    countdown.ts       # staging checks, countdown, jump-start detection
    delta.ts           # reference profiles, live gap, theoretical best
    filters.ts         # fix validation and smoothing
    clock.ts           # Clock interface (system / fake)
  gps/
    GpsSource.ts       # interface: subscribe(fix => …), start(), stop()
    browserGps.ts      # navigator.geolocation + wake lock
    replayGps.ts       # replays recorded NDJSON/GPX at 1×–50× speed
    simulatorGps.ts    # synthetic drive (incl. standing launches) with noise and dropouts
  feedback/
    audio.ts           # Web Audio beeps, scheduled countdown
    speech.ts          # Web Speech callouts
    haptics.ts         # Vibration API
  data/
    db.ts              # Dexie schema + migrations
    routesRepo.ts  runsRepo.ts  settingsRepo.ts
  workers/
    recompute.worker.ts
  features/
    routes/  editor/  arm/  countdown/  live/  history/  analysis/  settings/
  ui/                  # shared components (BigTimer, DeltaBadge, SectorStrip, StartLights)
tests/
  fixtures/            # real recorded drives (.ndjson) + expected results
```

### 4.9 Data model

```ts
type RouteType = 'circuit' | 'stage';
type StartMode = 'flying' | 'standing';

interface Route {
  id: string;                          // crypto.randomUUID()
  name: string;
  type: RouteType;
  geometry: [number, number][];        // [lon, lat], resampled
  lengthM: number;
  intervalM: number;                   // 100–1000, step 50, default 100
  gateWidthM: number;                  // default 40
  startGate: Gate;
  finishGate?: Gate;                   // stage only
  defaultStartMode: StartMode;         // default 'flying' for circuit, 'standing' for stage
  defaultCountdownS: number;           // 3–10, default 5
  source: 'drawn' | 'snapped' | 'recorded' | 'gpx' | 'osm';
  createdAt: number;
  updatedAt: number;
}

interface Gate { a: [number, number]; b: [number, number]; bearingDeg: number; }

interface Session {
  id: string;
  routeId: string;
  startedAt: number;
  notes?: string;
}

interface Run {
  id: string;
  sessionId: string;
  routeId: string;
  lapNumber: number;                   // 1 for stages
  startMode: StartMode;
  countdownS?: number;                 // standing only
  jumpStart?: boolean;                 // standing only
  launchMs?: number;                   // standing only, approximate
  clockOffsetMs?: number;              // standing only, diagnostics
  startTime: number;                   // epoch ms
  totalMs: number;
  intervalM: number;                   // interval used for sectorMs (cache key)
  sectorMs: number[];
  sectorFlags: ('ok' | 'estimated')[];
  valid: boolean;
  invalidReason?: 'off-route' | 'gps-gap' | 'user-abort' | 'jump-start';
  traceId: string;
}

interface Trace {                      // stored separately: large, rarely needed
  id: string;
  points: { t: number; lat: number; lon: number; acc: number; spd?: number; s?: number }[];
}

interface Settings {
  units: 'metric' | 'imperial';
  deltaSmoothingS: number;
  audioCallouts: 'off' | 'beep' | 'voice';
  jumpStartInvalidates: boolean;
  theme: 'dark' | 'light' | 'sunlight';
}
```

Dexie indexes:
- `runs`: `[routeId+startMode+totalMs]` (best per start mode), `[routeId+startTime]` (history), `sessionId`.
- `routes`: `updatedAt`.

---

## 5. UX notes

**Route editor**
- An interval slider from 100 to 1000 m (step 50), with numeric input too.
- The map updates the checkpoint markers live as you move it.
- Shows "N sectors, last sector X m".

**Arm screen**
- A start-mode toggle (Flying / Standing) and a countdown picker (3–10 s).
- A GPS quality indicator.
- Live status:
  - flying: "behind start line ✓",
  - standing: "at start ✓ / stationary ✓".

**Countdown screen**
- Very large digits and a rally-style row of lights.
- Turns green at zero, then switches straight to the live screen.
- A red "JUMP START" banner if one is detected.
- A big cancel button.

**Live screen**
- **No taps needed while driving.**
- Very large, high-contrast digits in a font with equal-width numbers, so they don't jitter. Dark theme by default.
- Layout, top to bottom: **live gap** → running time → last sector delta → sector strip → speed and GPS status.
- Works in portrait and landscape.
- Optional beeps or voice callouts.

---

## 6. Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Phone GPS too slow or inaccurate for short sectors | Medium | High | Week-1 spike; adjustable interval (100–1000 m); interpolation; external GPS / native as a fallback |
| R2 | Browser stops GPS when the screen locks | High | High | Wake Lock API, warnings, `visibilitychange` detection, flag the run |
| R3 | Bad GPS under trees or in valleys | High (rally) | Medium | Projection-based checkpoints, wide gates, gap interpolation, `estimated` flags |
| R4 | False flying start from GPS drift | Medium | Medium | Provisional crossing + forward-progress confirmation; direction check |
| R5 | **False jump-start** from GPS drift while stationary | Medium | Medium | Thresholds tuned on Phase 0 data (3 m / 2 m/s over 2 fixes); setting to warn only; accelerometer later |
| R6 | **System clock vs. GPS timestamps disagree** (standing start) | Low–Medium | High | Measure the offset in Phase 0; median offset correction; log the offset per run |
| R7 | **Countdown sound late or muted on iOS** | Medium | Medium | Enable audio during the START tap; schedule beeps ahead with Web Audio; visual countdown is the main signal |
| R8 | Snapping to the wrong part of the track | Medium | Medium | Windowed projection |
| R9 | Routing API doesn't know forest/gravel stage roads | Medium | Low | Manual edits; record-a-route; GPX import |
| R10 | iOS PWA quirks (storage eviction, permissions) | Medium | Medium | `navigator.storage.persist()`; backup/export; early iOS testing |
| R11 | Safety / legal | — | High | Hands-free design, audio, disclaimer: intended for closed tracks and closed roads |

---

## 7. Development plan

Estimates assume **one developer working part-time (~10–15 h/week)**. Halve them for full-time work.

### Phase 0: GPS feasibility spike (1 week)  ⚠ go/no-go
- A minimal page that logs every fix to NDJSON with a wake lock. Each fix records:
  - `t`, `receivedAt`, lat, lon, accuracy, speed, heading.
- Drive a known loop 5+ times on each target phone.
- **Also record 2–3 minutes stationary**, then a standing launch. This measures drift, clock offset and launch detection.
- ✅ Exit criteria:
  - ≥0.9 Hz sustained,
  - median accuracy ≤8 m,
  - stationary drift is understood,
  - clock offset is measured.

### Phase 1: Timing engine + test harness (3 weeks)
- `geo`, `route` (adjustable interval, remainder rule, single-sector edge case).
- `tracker` (flying start, checkpoints, laps, finish).
- `countdown` (staging checks, countdown, jump start, launch time, `Clock` interface).
- `delta` (live gap, theoretical best, grouping by start mode).
- Simulator (including standing launches) and replay of Phase 0 logs.
- ✅ Exit criteria:
  - Simulated error: total time < 0.2 s, checkpoint < 0.3 s (95th percentile, 1 Hz, 3 m noise).
  - No false jump starts on the recorded stationary logs.
  - Engine test coverage above 90%.

### Phase 2: Routes & map (2–3 weeks)
- App shell, Dexie, settings.
- MapLibre map; route list.
- Route editor:
  - draw and edit with Terra Draw; snap to roads,
  - circuit/stage; gates,
  - **interval slider with live checkpoint preview**,
  - default start mode and countdown.
- Record-a-route; GPX import.
- When the interval changes, recompute runs in a Web Worker.

### Phase 3: Arm, countdown & live timing (2–3 weeks)
- Arm screen with the start-mode toggle and countdown picker.
- Staging checks UI (flying and standing).
- Countdown screen: lights, Web Audio beeps, vibration, jump-start banner, cancel.
- Live screen; wake lock; save runs automatically.
- Basic audio callouts.
- ✅ Exit criteria:
  - field test of a flying-start circuit (multiple laps) and a standing-start stage,
  - all runs saved, with no interaction while driving.

### Phase 4: History & analysis (2 weeks)
- History grouped by session and start mode; best run; theoretical best.
- Run detail: sector table, delta and speed charts (uPlot), trace on the map coloured by delta.
- Pick the reference run; compare two runs.
- Export GPX/CSV; back up and restore as JSON.

### Phase 5: PWA hardening & polish (1–2 weeks)
- Service worker, install prompt, persistent storage, tile caching.
- Sunlight theme, landscape, accessibility, onboarding, disclaimer.
- Error monitoring.
- Deploy.
- ✅ **MVP done** (~11–14 weeks part-time).

### Phase 6+: Optional extensions
- Accounts and sync, shared routes, leaderboards.
- External Bluetooth GPS, Capacitor native app.
- Accelerometer launch detection, hands-free countdown.
- OSM raceway picker, video overlay.

### Timeline overview

```
Week:      1   2   3   4   5   6   7   8   9  10  11  12  13  14
Phase 0  ███
Phase 1      █████████████
Phase 2                   ██████████
Phase 3                             ██████████
Phase 4                                       ███████
Phase 5                                              ██████
                                                          ▲ MVP
```

---

## 8. Testing strategy

| Level | What | How |
|---|---|---|
| Unit | Geometry, checkpoints for intervals 100–1000 m, remainder rule, interpolation, lap guards | Vitest; table-driven cases |
| Countdown | Tick timing, cancel, jump-start thresholds, transition at zero, clock-offset correction | Vitest with a **fake `Clock`** and scripted GPS fixes |
| Engine property tests | Over random routes, intervals, speeds and noise: checkpoint times are monotonic, sector sum = total, no double laps, recompute after an interval change matches a fresh run | fast-check |
| Accuracy | Simulated drives with known ground truth → error percentiles | Simulator; checked in CI |
| Regression | Real recorded drives (flying and standing) → expected times, with tolerance | `tests/fixtures/*.ndjson` |
| Component | Sector strip, interval slider, countdown screen | Vitest + Testing Library |
| E2E | Arm → countdown → replay GPS → run saved → appears in history | Playwright with a mocked `GpsSource` and a controlled clock (`page.clock`) |
| Field | Walk → cycle → drive | Checklist per release |

---

## 9. Recommended technology stack (whole project)

### 9.1 Core

| Area | Recommendation | Why | Alternatives |
|---|---|---|---|
| Language | **TypeScript** (strict mode) | The timing maths and data model benefit from types; one language from front to back | — |
| UI framework | **React 19** | Largest ecosystem for maps, charts and UI kits; easy to hire for or get help with | SolidJS or Svelte 5 (faster, less boilerplate, smaller ecosystem) |
| Build tool | **Vite** | Fast dev server, first-class PWA plugin, Web Worker support | — |
| Why not Next.js | — | No server rendering is needed: this is an offline-first app that runs on the phone. Next.js would only add complexity | — |
| Routing (pages) | **TanStack Router** | Type-safe routes and URL search params (e.g. `?compare=runId`) | React Router 7 |
| App state | **Zustand** | Small and simple; the live state is updated outside React by the engine | Jotai |
| Persisted data in UI | **dexie-react-hooks** (`useLiveQuery`) | Lists update automatically when the DB changes | TanStack Query (add it once a backend exists) |
| Styling | **Tailwind CSS v4** | Fast to build with; easy to give the live screen its own theme | CSS Modules |
| Components | **shadcn/ui** (Radix UI under the hood) | Accessible dialogs, sliders, tabs and toggles; the code lives in your repo | Mantine |
| Icons | **lucide-react** | Same family as shadcn | — |
| Forms & validation | **React Hook Form + Zod** | Zod also validates GPX/JSON imports and backups | Valibot |
| Package manager | **pnpm** | Fast, strict | npm |
| Lint & format | **Biome** | One fast tool for linting and formatting | ESLint + Prettier |

### 9.2 Maps & geo

| Area | Recommendation | Notes |
|---|---|---|
| Map renderer | **MapLibre GL JS** + `react-map-gl` (MapLibre build) | Free, open-source, vector tiles, smooth on mobile |
| Tiles | **MapTiler** (free tier) or **OpenFreeMap** (free); **Protomaps PMTiles** for self-hosted/offline | **Don't use** `tile.openstreetmap.org` in an app (usage policy) |
| Satellite imagery | MapTiler Satellite / Esri World Imagery | Helps you see the actual road when drawing a stage |
| Drawing and editing | **Terra Draw** | Works with MapLibre; supports lines, editing and snapping |
| Snap to roads | **OpenRouteService** (free key) or **GraphHopper** | Called only while creating routes |
| Place search | **MapTiler Geocoding** or **Photon** (Komoot) | Nominatim has strict usage limits |
| Circuit picker (later) | **Overpass API** (`highway=raceway`) | — |
| Geometry (setup) | **Turf.js** modular packages (`@turf/length`, `along`, `simplify`, `nearest-point-on-line`, `bearing`) | Used for preprocessing and the editor |
| Geometry (hot path) | **Custom `engine/geo.ts`** | Planar maths, windowed projection; zero allocations per fix |
| GPX | **@tmcw/togeojson** (import); small custom writer (export) | — |

### 9.3 Device & browser APIs

| API | Used for | Support notes |
|---|---|---|
| Geolocation (`watchPosition`) | GPS fixes | All browsers; HTTPS only |
| Screen Wake Lock | Keep the screen on during runs | Chrome/Edge, Safari 16.4+ |
| Page Visibility | Detect when the app is hidden and flag the run | All |
| `performance.now()` / `timeOrigin` | Steady clock for the countdown and live timer | All |
| `requestAnimationFrame` | Smooth 60 fps clock display | All |
| Web Audio API | Countdown beeps (scheduled precisely), delta beeps | All; iOS requires a tap to enable sound |
| Web Speech (`speechSynthesis`) | Voice callouts | All (voices differ by device) |
| Vibration | Haptic countdown and alerts | Android only |
| DeviceMotion (later) | Launch detection with the accelerometer | iOS asks permission |
| Storage (`navigator.storage.persist()`) | Ask the browser not to delete data | All modern browsers |
| Web Bluetooth (later) | External GPS | Chrome Android/desktop only |
| File System Access / download | Export and backup | Falls back to a normal file download |

### 9.4 Data, offline & performance

| Area | Recommendation |
|---|---|
| Local database | **Dexie.js 4** (IndexedDB) |
| IDs | `crypto.randomUUID()` (ready for future sync) |
| PWA / service worker | **vite-plugin-pwa** (Workbox): precache the app shell, cache tiles at runtime |
| Background jobs | **Web Worker + Comlink**: recompute runs after an interval change, parse GPX, simplify recorded routes |
| Compression (backups) | **fflate** |
| Charts | **uPlot** (very fast for long traces); Apache ECharts if you want richer interaction |
| Number/date formatting | Built-in `Intl` API (no library needed) |
| Translations (if needed) | **i18next / react-i18next** |

### 9.5 Quality, delivery & operations

| Area | Recommendation |
|---|---|
| Unit / component tests | **Vitest** + **@testing-library/react** |
| Property-based tests | **fast-check** |
| E2E | **Playwright** (geolocation override, `page.clock` for countdowns, mobile emulation) |
| API mocking | **MSW** (routing / geocoding APIs) |
| CI | **GitHub Actions**: lint, type-check, tests, accuracy benchmark, build |
| Hosting | **Cloudflare Pages** (preview deploy per pull request, HTTPS, free) |
| Error monitoring | **Sentry** browser SDK. **Remove coordinates from error reports**: location data is personal. |
| Analytics (optional) | Plausible, or none |

### 9.6 Backend & native (post-MVP)

| Area | Recommendation | Notes |
|---|---|---|
| Backend | **Supabase**: Postgres + **PostGIS**, Auth, row-level security, Storage | Store traces as compressed files in Storage; routes and runs as rows |
| Sync | Simple custom sync first (`updatedAt` timestamps + soft deletes); or **Dexie Cloud** (paid, built for Dexie); or **PowerSync** (Supabase ↔ SQLite/IndexedDB) | Decide when you add accounts |
| Leaderboards | Supabase SQL views or Edge Functions, with server-side trace validation | Needs anti-cheat rules |
| Native wrapper | **Capacitor** + a background-geolocation plugin | Reuses the same web code |

---

## 10. Technologies per feature

| Feature | Frontend / UI | Logic / engine | Data / APIs | Testing |
|---|---|---|---|---|
| **Route library** | shadcn list, cards, search | — | Dexie `routes`, `useLiveQuery` | Testing Library |
| **Route editor: draw / edit** | MapLibre, react-map-gl, Terra Draw | Turf (`simplify`, `length`) | MapTiler / OpenFreeMap tiles, satellite layer | Playwright (draw flow) |
| **Route editor: snap to roads** | Terra Draw waypoints | Turf to merge segments | OpenRouteService / GraphHopper | MSW mocks |
| **Route editor: record a route** | Recording HUD | `engine/filters`, Douglas-Peucker (`@turf/simplify`), resample | Geolocation, Wake Lock | Replay fixtures |
| **GPX import** | File input / drag-drop | `@tmcw/togeojson` in a Web Worker | Zod validation | Unit tests with sample GPX files |
| **Place search** | Combobox (shadcn) | — | MapTiler Geocoding / Photon | MSW |
| **Adjustable sectors (100–1000 m)** | shadcn Slider + number input, live map markers | `engine/route.ts` (checkpoints, remainder rule) | `Route.intervalM`; recompute runs in a Web Worker (Comlink) | fast-check over intervals |
| **Start/finish gates** | Draggable gate handles on the map | `engine/geo.ts` (perpendicular gate, bearing) | `Route.startGate/finishGate` | Unit |
| **Arming & GPS quality** | Status chips, accuracy dot | `engine/filters`, `tracker` states | Geolocation, Wake Lock, Page Visibility | Simulator |
| **Flying start / laps / finish** | Live screen | `engine/tracker.ts` (gate crossing, jitter guard, lap guard) | — | Unit + replay |
| **Standing start countdown (3–10 s)** | Countdown screen, start-light component, Tailwind animations | `engine/countdown.ts` (staging checks, jump start, `Clock`) | `performance.now`, Web Audio (scheduled beeps), Vibration | Vitest with a fake clock; Playwright `page.clock` |
| **Jump start / launch time** | Banner, launch readout | `engine/countdown.ts` | Geolocation (later DeviceMotion) | Stationary-drift fixtures |
| **Sector timing** | Sector strip | `engine/tracker.ts` (windowed projection + interpolation) | — | Accuracy benchmark |
| **Live delta** | BigTimer, DeltaBadge (equal-width digits), 60 fps via rAF | `engine/delta.ts` (binary search over reference profile, smoothing) | Reference run trace from Dexie | Unit + property tests |
| **Audio callouts** | Settings toggle | Event subscriber | Web Audio, `speechSynthesis` | Manual + unit (event → sound mapping) |
| **Run saving** | Post-run summary sheet | Tracker `finish` event → repository | Dexie `runs`, `traces` (separate table) | Unit, E2E |
| **History & bests** | Tables (TanStack Table), grouping by session/start mode | Theoretical best calculation | Dexie compound indexes | Unit |
| **Run analysis** | uPlot charts (delta and speed vs. distance), MapLibre trace coloured by delta | `engine/delta.ts` | Traces | Visual check / snapshot |
| **Compare runs** | Two-run overlay, TanStack Router search params | `delta.ts` | — | E2E |
| **Export / backup** | Buttons, file download | GPX writer, JSON + fflate in a Web Worker | File System Access / download | Round-trip tests (export → import) |
| **Offline / install** | Install prompt, offline badge | — | vite-plugin-pwa (Workbox), `storage.persist()` | Lighthouse PWA audit, Playwright offline mode |
| **Settings** | shadcn form, React Hook Form + Zod | — | Dexie `settings` | Unit |
| **Accounts & sync** *(later)* | Auth UI (Supabase Auth UI or custom) | Sync engine | Supabase, PostGIS, RLS; Dexie Cloud / PowerSync | Integration tests against the local Supabase CLI |
| **Leaderboards** *(later)* | Tables | Trace validation | Supabase views / Edge Functions | Integration |
| **External GPS** *(later)* | Device picker | NMEA/UBX parser → `GpsSource` | Web Bluetooth / Capacitor BLE | Recorded NMEA fixtures |

---

## 11. Open questions

1. **Target devices:** iOS, Android, or both? If you need iOS + an external GPS, that pushes you towards Capacitor.
2. **Vehicles and speeds:** car, motorbike, bicycle, karting? This affects gate widths, filters and jump-start thresholds.
3. **Single user or multi-user?** This decides when you need a backend.
4. **Jump start rule:** should it invalidate the run, or only warn? (Proposed: warn by default, with a setting.)
5. **Countdown trigger:** is a tap on START fine, or do you want hands-free auto-start from day one?
6. **Default reference for the delta:** all-time best, or session best (always within the same start mode)?
7. **Units and language.**
8. **Hardware budget:** is a ~€100–250 external 10–25 Hz GPS acceptable for serious use?
