import type { Fix } from '../engine/filters';
import { Emitter, type GpsSource, type GpsStatus } from './GpsSource';
import { keepScreenOn, releaseScreen } from './wakeLock';

/** navigator.geolocation.watchPosition with high accuracy, plus a screen wake lock. */
export class BrowserGps implements GpsSource {
  readonly name = 'Device GPS';
  private watchId: number | null = null;
  private fixes = new Emitter<Fix>();
  private status = new Emitter<{ status: GpsStatus; message?: string }>();

  async start(): Promise<void> {
    if (this.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      this.status.emit({ status: 'unavailable', message: 'Geolocation is not supported' });
      return;
    }
    this.status.emit({ status: 'starting' });
    await keepScreenOn();
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        this.status.emit({ status: 'active' });
        this.fixes.emit({
          t: pos.timestamp,
          lat: c.latitude,
          lon: c.longitude,
          acc: c.accuracy,
          spd: c.speed,
          hdg: c.heading,
          receivedAt: performance.timeOrigin + performance.now(),
        });
      },
      (err) => {
        const status: GpsStatus = err.code === err.PERMISSION_DENIED ? 'denied' : 'error';
        this.status.emit({ status, message: err.message });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    releaseScreen();
    this.status.emit({ status: 'idle' });
  }

  subscribe(onFix: (fix: Fix) => void): () => void {
    return this.fixes.on(onFix);
  }

  onStatus(cb: (status: GpsStatus, message?: string) => void): () => void {
    return this.status.on((s) => cb(s.status, s.message));
  }
}
