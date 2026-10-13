import { useEffect, useId, useState } from 'react';
import { INTERVAL_SLIDER, parseIntervalInput } from './preview';

interface Props {
  value: number;
  onChange: (intervalM: number) => void;
  /** e.g. "23 sectors, last sector 130 m" */
  summary?: string;
  warn?: boolean;
}

/** Sector interval: a 100–1000 m slider in 50 m steps, with a number box (§5). */
export function IntervalSlider({ value, onChange, summary, warn }: Props) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const parsed = parseIntervalInput(text);
    if (parsed === undefined) {
      setText(String(value));
      return;
    }
    setText(String(parsed));
    if (parsed !== value) onChange(parsed);
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        Sector interval
      </label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={INTERVAL_SLIDER.min}
          max={INTERVAL_SLIDER.max}
          step={INTERVAL_SLIDER.step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-amber-400"
        />
        <input
          type="number"
          aria-label="Sector interval in metres"
          inputMode="numeric"
          min={INTERVAL_SLIDER.min}
          max={INTERVAL_SLIDER.max}
          step={INTERVAL_SLIDER.step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-right tabular-nums"
        />
        <span className="text-sm text-neutral-400">m</span>
      </div>
      {summary && (
        <p role="status" className={warn ? 'text-sm text-amber-400' : 'text-sm text-neutral-400'}>
          {summary}
        </p>
      )}
    </div>
  );
}
