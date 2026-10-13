// Read-only map for run analysis: the route, its gates and a run's trace coloured by where time was
// won (green) or lost (red) against the reference, or by speed when there is no reference.
// Thin MapLibre adapter: the colours come from `coloredTrace` properties.

import 'maplibre-gl/dist/maplibre-gl.css';
import { type GeoJSONSource, Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { Route } from '../../data/types';
import { boundsOf } from './drawGlue';
import { MAP_STYLE } from './MapView';

type FeatureCollection = { type: 'FeatureCollection'; features: object[] };

interface Props {
  route: Route;
  trace: FeatureCollection;
  /** 'delta': colour by `rate` (ms per 100 m); 'speed': colour by `kmh`. */
  colorBy: 'delta' | 'speed';
  className?: string;
}

const DELTA_COLOR = [
  'interpolate',
  ['linear'],
  ['get', 'rate'],
  -150,
  '#16a34a',
  -20,
  '#86efac',
  0,
  '#e5e5e5',
  20,
  '#fca5a5',
  150,
  '#dc2626',
];
const SPEED_COLOR = [
  'interpolate',
  ['linear'],
  ['get', 'kmh'],
  20,
  '#3b82f6',
  80,
  '#facc15',
  160,
  '#ef4444',
];

function routeOverlay(route: Route): FeatureCollection {
  const gates = [{ kind: 'start', g: route.startGate }];
  if (route.finishGate) gates.push({ kind: 'finish', g: route.finishGate });
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'route' },
        geometry: { type: 'LineString', coordinates: route.geometry },
      },
      ...gates.map(({ kind, g }) => ({
        type: 'Feature',
        properties: { kind },
        geometry: { type: 'LineString', coordinates: [g.a, g.b] },
      })),
    ],
  };
}

export function TraceMap({ route, trace, colorBy, className }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!container.current) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container: container.current, style: MAP_STYLE });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    const b = boundsOf(route.geometry);
    if (b) map.fitBounds(b, { padding: 30, duration: 0 });
    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: routeOverlay(route) as never });
      map.addSource('trace', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'route'],
        paint: { 'line-color': '#525252', 'line-width': 9, 'line-opacity': 0.6 },
      });
      map.addLayer({
        id: 'gates',
        type: 'line',
        source: 'route',
        filter: ['in', ['get', 'kind'], ['literal', ['start', 'finish']]],
        paint: {
          'line-color': ['match', ['get', 'kind'], 'start', '#22c55e', '#ef4444'],
          'line-width': 5,
        },
      });
      map.addLayer({
        id: 'trace',
        type: 'line',
        source: 'trace',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-width': 5 },
      });
      setReady(true);
    });
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [route]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('trace') as GeoJSONSource | undefined)?.setData(trace as never);
    map.setPaintProperty(
      'trace',
      'line-color',
      (colorBy === 'delta' ? DELTA_COLOR : SPEED_COLOR) as never,
    );
  }, [trace, colorBy, ready]);

  return (
    <div className={`relative ${className ?? 'h-80 w-full'}`}>
      <div ref={container} className="h-full w-full" data-testid="trace-map" />
      {failure && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center bg-neutral-900 p-4 text-center text-sm text-neutral-400"
        >
          The map can't be shown on this device ({failure}).
        </div>
      )}
    </div>
  );
}
