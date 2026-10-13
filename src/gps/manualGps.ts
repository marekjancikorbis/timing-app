import type { Fix } from '../engine/filters';
import { Emitter, type GpsSource, type GpsStatus } from './GpsSource';

/** A GpsSource you push fixes into: unit tests, and the e2e test hook (`?gps=test`). */
export class ManualGps implements GpsSource {
  readonly name = 'Manual (test)';
  running = false;
  private fixes = new Emitter<Fix>();
  private status = new Emitter<{ status: GpsStatus; message?: string }>();

  async start(): Promise<void> {
    this.running = true;
    this.status.emit({ status: 'active' });
  }

  stop(): void {
    this.running = false;
    this.status.emit({ status: 'idle' });
  }

  /** Deliver a fix (ignored while stopped, like a real receiver). */
  push(fix: Fix): void {
    if (this.running) this.fixes.emit(fix);
  }

  subscribe(onFix: (fix: Fix) => void): () => void {
    return this.fixes.on(onFix);
  }

  onStatus(cb: (status: GpsStatus, message?: string) => void): () => void {
    return this.status.on((s) => cb(s.status, s.message));
  }
}
