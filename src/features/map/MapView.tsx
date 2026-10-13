// Thin MapLibre + Terra Draw adapter. All decisions live in the editor reducer and preview;
// this only draws what it is given and reports clicks and line edits.

import 'maplibre-gl/dist/maplibre-gl.css';
import {
  type GeoJSONSource,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { TerraDraw, TerraDrawLineStringMode, TerraDrawSelectMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { LonLat } from '../../engine/geo';
import { boundsOf, type FeatureId, lineFeature, lineFromSnapshot, sameLine } from './drawGlue';

// MapLibre loads its worker from next to its own module, which Vite's dependency pre-bundling
// moves. Point it at the real file (self-contained, so this also works in production builds).
setWorkerUrl(maplibreWorkerUrl);

/** OpenFreeMap: free vector tiles, no key (§9.2). */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_CENTER: LonLat = [14.42, 50.08];

type FeatureCollection = { type: 'FeatureCollection'; features: unknown[] };
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export type MapInteraction = 'draw' | 'snap' | 'view';

interface Props {
  geometry: LonLat[];
  /** Gates, checkpoints (and the route line when not editing), from `previewGeoJson`. */
  overlay: FeatureCollection | null;
  waypoints?: LonLat[];
  interaction: MapInteraction;
  onGeometryChange?: (geometry: LonLat[]) => void;
  onMapClick?: (point: LonLat) => void;
  className?: string;
}

export function MapView({
  geometry,
  overlay,
  waypoints = [],
  interaction,
  onGeometryChange,
  onMapClick,
  className,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const readyRef = useRef(false);
  const lastLine = useRef<LonLat[]>([]);
  const pendingApply = useRef<(() => void) | null>(null);
  /** Terra Draw's id of the route line, once it exists. */
  const lineId = useRef<FeatureId | null>(null);
  // latest callbacks without re-creating the map
  const cb = useRef({ onGeometryChange, onMapClick, interaction });
  cb.current = { onGeometryChange, onMapClick, interaction };

  // Create the map once.
  useEffect(() => {
    if (!container.current) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: container.current,
        style: MAP_STYLE,
        center: DEFAULT_CENTER,
        zoom: 12,
      });
    } catch (e) {
      // e.g. no WebGL: the rest of the editor (import, recording, settings) still works
      setFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('overlay', { type: 'geojson', data: EMPTY as never });
      map.addSource('waypoints', { type: 'geojson', data: EMPTY as never });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'overlay',
        filter: ['==', ['get', 'kind'], 'route'],
        paint: { 'line-color': '#f59e0b', 'line-width': 4 },
      });
      map.addLayer({
        id: 'gates',
        type: 'line',
        source: 'overlay',
        filter: ['in', ['get', 'kind'], ['literal', ['start', 'finish']]],
        paint: {
          'line-color': ['match', ['get', 'kind'], 'start', '#22c55e', '#ef4444'],
          'line-width': 5,
        },
      });
      map.addLayer({
        id: 'checkpoints',
        type: 'circle',
        source: 'overlay',
        filter: ['==', ['get', 'kind'], 'checkpoint'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#0a0a0a',
          'circle-stroke-width': 2,
        },
      });
      // Text needs the style's font glyphs; without them adding the layer throws.
      if (map.getStyle().glyphs) {
        map.addLayer({
          id: 'checkpoint-labels',
          type: 'symbol',
          source: 'overlay',
          filter: ['==', ['get', 'kind'], 'checkpoint'],
          layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.3] },
          paint: { 'text-color': '#ffffff', 'text-halo-color': '#0a0a0a', 'text-halo-width': 1.5 },
        });
      }
      map.addLayer({
        id: 'waypoints',
        type: 'circle',
        source: 'waypoints',
        paint: {
          'circle-radius': 7,
          'circle-color': '#f97316',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });

      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawLineStringMode(),
          new TerraDrawSelectMode({
            flags: {
              linestring: {
                feature: {
                  draggable: false,
                  coordinates: { draggable: true, midpoints: true, deletable: true },
                },
              },
            },
          }),
        ],
      });
      draw.start();
      const report = () => {
        const found = lineFromSnapshot(draw.getSnapshot(), lineId.current);
        if (!found) return;
        lineId.current = found.id ?? null; // a freshly drawn line has Terra Draw's own id
        if (sameLine(found.geometry, lastLine.current)) return;
        lastLine.current = found.geometry;
        cb.current.onGeometryChange?.(found.geometry);
      };
      draw.on('finish', report);
      draw.on('change', (_ids, type) => {
        // While a line is being drawn, every mouse move updates it: only a 'finish' counts there.
        // In select mode, updates are vertex drags on the finished line.
        if (type === 'update' && draw.getMode() === 'select') report();
      });
      drawRef.current = draw;
      readyRef.current = true;
      pendingApply.current?.();
      pendingApply.current = null;
    });

    map.on('click', (e) => {
      if (cb.current.interaction === 'snap') cb.current.onMapClick?.([e.lngLat.lng, e.lngLat.lat]);
    });

    return () => {
      readyRef.current = false;
      drawRef.current?.stop();
      drawRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Push state into the map whenever it changes (and once the map is ready).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const draw = drawRef.current;
      if (!draw) return;
      const editing = interaction === 'draw';
      // Line: shown by Terra Draw while drawing/editing, by the overlay otherwise.
      // A line that didn't come from drawing on this map (load, import, recording, snap) is new
      // to the view: frame it. Never move the map under the user's own drawing.
      const external = !sameLine(geometry, lastLine.current);
      if (external || !editing) {
        draw.clear();
        lineId.current = null;
        lastLine.current = geometry;
      }
      if (editing) {
        if (geometry.length >= 2) {
          if (lineId.current == null || !draw.hasFeature(lineId.current)) {
            const id = draw.getFeatureId(); // ids must match Terra Draw's id strategy
            const [result] = draw.addFeatures([lineFeature(geometry, id) as never]);
            lineId.current = result?.valid ? id : null;
          }
          draw.setMode('select');
          if (lineId.current != null) draw.selectFeature(lineId.current);
        } else {
          draw.setMode('linestring');
        }
      } else {
        draw.setMode('static');
      }
      const features = (overlay?.features ?? []).filter(
        (f) => !(editing && (f as { properties?: { kind?: string } }).properties?.kind === 'route'),
      );
      (map.getSource('overlay') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features,
      } as never);
      (map.getSource('waypoints') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: waypoints.map((p, i) => ({
          type: 'Feature',
          properties: { index: i },
          geometry: { type: 'Point', coordinates: p },
        })),
      } as never);
      const b = external ? boundsOf(geometry) : null;
      if (b) map.fitBounds(b, { padding: 40, duration: 0 });
    };
    if (readyRef.current) apply();
    else pendingApply.current = apply; // run once the style and Terra Draw are ready
  }, [geometry, overlay, waypoints, interaction]);

  return (
    <div className={`relative ${className ?? 'h-full w-full'}`}>
      <div ref={container} className="h-full w-full" data-testid="map" />
      {failure && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center bg-neutral-900 p-4 text-center text-sm text-neutral-400"
        >
          The map can't be shown on this device ({failure}). You can still import GPX files or
          record a route.
        </div>
      )}
    </div>
  );
}
