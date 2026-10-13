import type { Fix } from '../engine/filters';

export type GpsStatus = 'idle' | 'starting' | 'active' | 'denied' | 'unavailable' | 'error';

/** Anything that produces fixes: the browser, a recorded log, a simulator, later Bluetooth (§2.3). */
export interface GpsSource {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  subscribe(onFix: (fix: Fix) => void): () => void;
  onStatus?(cb: (status: GpsStatus, message?: string) => void): () => void;
}

/** Small helper for sources: a set of listeners. */
export class Emitter<T> {
  private listeners = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(v: T): void {
    for (const l of this.listeners) l(v);
  }
}
