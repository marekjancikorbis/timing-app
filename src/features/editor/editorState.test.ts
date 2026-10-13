import { describe, expect, it } from 'vitest';
import { straightGeometry } from '../../../tests/harness';
import { routeFromDraft } from '../../data/routeModel';
import type { LonLat } from '../../engine/geo';
import { ovalCircuit } from '../../gps/simulator';
import type { GpxCandidate } from '../routes/gpx';
import {
  type EditorAction,
  type EditorState,
  editorPreview,
  editorReducer,
  editorToDraft,
  initialEditorState,
  saveBlocker,
} from './editorState';

const run = (actions: EditorAction[], s: EditorState = initialEditorState()) =>
  actions.reduce(editorReducer, s);
const line = straightGeometry(1500);
const p = (x: number): LonLat => [14 + x * 0.001, 50];

describe('editor: drawing and basic fields', () => {
  it('starts clean with stage defaults', () => {
    expect(initialEditorState()).toMatchObject({
      type: 'stage',
      defaultStartMode: 'standing',
      intervalM: 100,
      gateWidthM: 40,
      defaultCountdownS: 5,
      dirty: false,
      mode: 'draw',
    });
    expect(initialEditorState('circuit').defaultStartMode).toBe('flying');
  });

  it('drawing a line makes it dirty and saveable once named', () => {
    const s = run([{ type: 'setGeometry', geometry: line }]);
    expect(s).toMatchObject({ dirty: true, source: 'drawn' });
    expect(saveBlocker(s)).toBe('Give the route a name.');
    const named = run([{ type: 'setName', name: 'Pass' }], s);
    expect(saveBlocker(named)).toBeNull();
    expect(editorToDraft(named)).toMatchObject({
      name: 'Pass',
      type: 'stage',
      source: 'drawn',
      geometry: line,
    });
  });

  it('explains what blocks saving', () => {
    expect(saveBlocker(initialEditorState())).toBe('Draw, snap, record or import the route first.');
    const tiny = run([
      { type: 'setGeometry', geometry: [p(0), [14.00001, 50]] },
      { type: 'setName', name: 'x' },
    ]);
    expect(saveBlocker(tiny)).toBe('Route is too short');
    const busy = run([
      { type: 'setGeometry', geometry: line },
      { type: 'setName', name: 'x' },
      { type: 'snapStarted' },
    ]);
    expect(saveBlocker(busy)).toBe('Wait for snapping to finish.');
  });

  it('clamps interval, gate width and countdown', () => {
    const s = run([
      { type: 'setInterval', intervalM: 1234 },
      { type: 'setGateWidth', gateWidthM: 3 },
      { type: 'setCountdown', seconds: 30 },
    ]);
    expect(s).toMatchObject({ intervalM: 1000, gateWidthM: 10, defaultCountdownS: 10 });
    expect(run([{ type: 'setGateWidth', gateWidthM: 250 }]).gateWidthM).toBe(100);
  });

  it('the preview follows the interval', () => {
    const s = run([
      { type: 'setGeometry', geometry: line },
      { type: 'setInterval', intervalM: 500 },
    ]);
    const pv = editorPreview(s);
    expect(pv.ok && pv.preview.sectorCount).toBe(3);
  });
});

describe('editor: route type and start mode', () => {
  it('switching type changes the default start mode until the user picks one', () => {
    const s = run([{ type: 'setRouteType', routeType: 'circuit' }]);
    expect(s.defaultStartMode).toBe('flying');
    const chosen = run(
      [
        { type: 'setStartMode', mode: 'standing' },
        { type: 'setRouteType', routeType: 'stage' },
        { type: 'setRouteType', routeType: 'circuit' },
      ],
      s,
    );
    expect(chosen.defaultStartMode).toBe('standing');
  });

  it('reverse flips the driving direction (and so the start/finish ends)', () => {
    const s = run([{ type: 'setGeometry', geometry: line }, { type: 'reverse' }]);
    expect(s.geometry[0]).toEqual(line.at(-1));
    const before = editorPreview(run([{ type: 'setGeometry', geometry: line }]));
    const after = editorPreview(s);
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok)
      expect(after.preview.startGate[0][0]).toBeCloseTo(before.preview.finishGate[0][0], 6);
  });
});

describe('editor: snap to roads', () => {
  it('collects waypoints, edits them, then takes the snapped road', () => {
    let s = run([
      { type: 'setMode', mode: 'snap' },
      { type: 'addWaypoint', point: p(0) },
      { type: 'addWaypoint', point: p(5) },
      { type: 'addWaypoint', point: p(9) },
      { type: 'moveWaypoint', index: 1, point: p(6) },
      { type: 'removeWaypoint', index: 2 },
      { type: 'moveWaypoint', index: 7, point: p(1) }, // out of range: ignored
      { type: 'removeWaypoint', index: -1 },
    ]);
    expect(s.waypoints).toEqual([p(0), p(6)]);
    s = run([{ type: 'snapStarted' }], s);
    expect(s.snapping).toBe(true);
    s = run([{ type: 'snapSucceeded', geometry: line }], s);
    expect(s).toMatchObject({ snapping: false, source: 'snapped', geometry: line, error: null });
  });

  it('keeps the line and shows the error when snapping fails', () => {
    const s = run([
      { type: 'setGeometry', geometry: line },
      { type: 'snapStarted' },
      { type: 'snapFailed', error: 'No road' },
    ]);
    expect(s).toMatchObject({ snapping: false, error: 'No road', geometry: line });
    expect(run([{ type: 'dismissError' }], s).error).toBeNull();
    expect(run([{ type: 'snapStarted' }], s).error).toBeNull();
  });

  it('entering snap mode on an existing line starts from its two ends', () => {
    const s = run([
      { type: 'setGeometry', geometry: line },
      { type: 'setMode', mode: 'snap' },
    ]);
    expect(s.waypoints).toEqual([line[0], line.at(-1)]);
    // existing waypoints are kept when switching back and forth
    const again = run(
      [
        { type: 'addWaypoint', point: p(3) },
        { type: 'setMode', mode: 'draw' },
        { type: 'setMode', mode: 'snap' },
      ],
      s,
    );
    expect(again.waypoints).toHaveLength(3);
  });

  it('a hand edit after snapping keeps the snapped source', () => {
    const s = run([
      { type: 'snapSucceeded', geometry: line },
      { type: 'setGeometry', geometry: line.slice(0, 1).concat([p(3)]) },
    ]);
    expect(s.source).toBe('snapped');
    expect(run([{ type: 'clear' }], s)).toMatchObject({
      geometry: [],
      waypoints: [],
      source: 'drawn',
    });
  });
});

describe('editor: imports and loading', () => {
  const candidate: GpxCandidate = {
    name: 'Kart track',
    kind: 'track',
    geometry: ovalCircuit(300, 80),
    lengthM: 1100,
    suggestedType: 'circuit',
    pointsIn: 400,
    droppedPoints: 0,
  };

  it('GPX import takes the line, type and name (but not over a typed name)', () => {
    const s = run([{ type: 'importGpx', candidate }]);
    expect(s).toMatchObject({
      source: 'gpx',
      type: 'circuit',
      name: 'Kart track',
      defaultStartMode: 'flying',
      dirty: true,
    });
    const named = run([
      { type: 'setName', name: 'Mine' },
      { type: 'importGpx', candidate },
    ]);
    expect(named.name).toBe('Mine');
  });

  it('a recording replaces the line and sets the type', () => {
    const s = run([
      { type: 'setMode', mode: 'snap' },
      { type: 'addWaypoint', point: p(1) },
      { type: 'importRecording', geometry: line, routeType: 'stage' },
    ]);
    expect(s).toMatchObject({
      source: 'recorded',
      type: 'stage',
      waypoints: [],
      mode: 'draw',
      geometry: line,
    });
  });

  it('loads a saved route clean, and "saved" clears the dirty flag', () => {
    const route = routeFromDraft(
      {
        name: 'Pass',
        type: 'stage',
        geometry: line,
        source: 'snapped',
        intervalM: 250,
        defaultStartMode: 'flying',
        defaultCountdownS: 7,
      },
      'r1',
      1,
    );
    const s = run([{ type: 'load', route }]);
    expect(s).toMatchObject({
      routeId: 'r1',
      name: 'Pass',
      source: 'snapped',
      intervalM: 250,
      defaultStartMode: 'flying',
      startModeChosen: true,
      defaultCountdownS: 7,
      dirty: false,
    });
    const edited = run([{ type: 'setName', name: 'Pass 2' }], s);
    expect(edited.dirty).toBe(true);
    expect(run([{ type: 'saved', route: { ...route, name: 'Pass 2' } }], edited)).toMatchObject({
      dirty: false,
      name: 'Pass 2',
    });
  });
});
