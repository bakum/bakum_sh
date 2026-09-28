import { EventEmitter } from 'node:events';
import type { CoreEvent } from '@bm/shared';

/** Fan-out of Core state changes to all subscribed clients (topic `events`). */
class EventBus {
  private ee = new EventEmitter();
  private pending: CoreEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.ee.setMaxListeners(100);
  }

  /** Events are batched per ~100 ms and de-duplicated to keep the UI responsive during builds. */
  emit(ev: CoreEvent): void {
    this.pending.push(ev);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const seen = new Set<string>();
        const batch = this.pending.filter((e) => {
          const key = JSON.stringify(e);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        this.pending = [];
        this.ee.emit('batch', batch);
      }, 100);
    }
  }

  on(cb: (batch: CoreEvent[]) => void): () => void {
    this.ee.on('batch', cb);
    return () => this.ee.off('batch', cb);
  }
}

export const bus = new EventBus();
