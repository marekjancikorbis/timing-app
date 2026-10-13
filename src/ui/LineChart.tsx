// Thin uPlot adapter (§9.4): fast enough for long traces. Draws what it is given; no logic here.

import 'uplot/dist/uPlot.min.css';
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

export interface ChartSeries {
  label: string;
  values: readonly number[];
  color: string;
  dash?: number[];
}

interface Props {
  /** Shared x values (distance in metres), ascending. */
  x: readonly number[];
  series: readonly ChartSeries[];
  yLabel: string;
  height?: number;
  /** Draw a line at y = 0 (for gaps). */
  zeroLine?: boolean;
  /** Format y values in the legend / axis. */
  formatY?: (v: number) => string;
  className?: string;
  'aria-label'?: string;
}

const AXIS = {
  stroke: '#a3a3a3',
  grid: { stroke: '#262626', width: 1 },
  ticks: { stroke: '#404040', width: 1 },
};

export function LineChart({
  x,
  series,
  yLabel,
  height = 220,
  zeroLine,
  formatY,
  className,
  'aria-label': ariaLabel,
}: Props) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || x.length === 0) return;
    const fmt = formatY ?? ((v: number) => v.toFixed(1));
    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height,
      legend: { show: true },
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time: false } },
      axes: [
        {
          ...AXIS,
          label: 'Distance (m)',
          values: (_u, ticks) => ticks.map((t) => (t >= 1000 ? `${t / 1000} km` : `${t}`)),
        },
        {
          ...AXIS,
          label: yLabel,
          size: 56,
          values: (_u, ticks) => ticks.map((t) => fmt(t)),
        },
      ],
      series: [
        { label: 'm', value: (_u, v) => (v == null ? '–' : `${Math.round(v)} m`) },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 2,
          dash: s.dash,
          spanGaps: false,
          value: (_u: uPlot, v: number | null) => (v == null ? '–' : fmt(v)),
        })),
      ],
      hooks: zeroLine
        ? {
            draw: [
              (u: uPlot) => {
                const y = u.valToPos(0, 'y', true);
                if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
                const ctx = u.ctx;
                ctx.save();
                ctx.strokeStyle = '#737373';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(u.bbox.left, y);
                ctx.lineTo(u.bbox.left + u.bbox.width, y);
                ctx.stroke();
                ctx.restore();
              },
            ],
          }
        : {},
    };
    const data = [
      Array.from(x),
      ...series.map((s) => Array.from(s.values, (v) => (Number.isFinite(v) ? v : null))),
    ] as uPlot.AlignedData;
    const plot = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() =>
      plot.setSize({ width: Math.max(200, el.clientWidth), height }),
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [x, series, yLabel, height, zeroLine, formatY]);

  if (x.length === 0) {
    return <p className="text-sm text-neutral-400">Not enough data for this chart.</p>;
  }
  return <div ref={box} className={className} role="img" aria-label={ariaLabel ?? yLabel} />;
}
