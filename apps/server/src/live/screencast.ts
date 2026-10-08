import type { RunCasesInput } from '@s1pilot/runner';

import type { ScreencastFrame } from './frame.js';

/** Tuning of a {@link ScreencastManager}. */
export interface ScreencastOptions {
  /** Receives every frame of a run that has subscribers. */
  onFrame: (runId: string, frame: ScreencastFrame) => void;
  /** Frame rate cap for Chromium screencasts. Default 10. */
  maxFps?: number;
  /** Screenshot interval of the Firefox/WebKit fallback in ms. Default 1000. */
  fallbackIntervalMs?: number;
  /** JPEG quality. Default 60. */
  quality?: number;
  /** Maximum frame width in px. Default 1280. */
  maxWidth?: number;
}

/** Playwright page handed out by the runner's `onPage` hook. */
type Page = Parameters<NonNullable<RunCasesInput['onPage']>>[0];

interface Source {
  runId: string;
  resultId: string;
  page: Page;
  seq: number;
  /** True while the source should produce frames. */
  active: boolean;
  /** Serialises start/stop so they never interleave. */
  chain: Promise<void>;
  stop?: () => Promise<void>;
  released: boolean;
}

interface CdpFrame {
  data: string;
  sessionId: number;
  metadata: { deviceWidth?: number; deviceHeight?: number };
}

/**
 * Streams JPEG frames of the pages registered by workers. A source only runs while its run has at least one
 * subscriber (`setDemand`): Chromium uses `Page.startScreencast` (acked, at most `maxFps`), Firefox/WebKit
 * fall back to one screenshot per second.
 */
export class ScreencastManager {
  private readonly sources = new Map<string, Set<Source>>();
  private readonly demand = new Map<string, number>();
  private readonly o: Required<Omit<ScreencastOptions, 'onFrame'>> & Pick<ScreencastOptions, 'onFrame'>;

  constructor(opts: ScreencastOptions) {
    this.o = { maxFps: 10, fallbackIntervalMs: 1000, quality: 60, maxWidth: 1280, ...opts };
  }

  /** Registers the page of a running case; returns the function that unregisters it (and stops streaming). */
  attach(runId: string, resultId: string, page: Page): () => Promise<void> {
    const source: Source = { runId, resultId, page, seq: 0, active: false, chain: Promise.resolve(), released: false };
    let set = this.sources.get(runId);
    if (!set) this.sources.set(runId, (set = new Set()));
    set.add(source);
    const release = async (): Promise<void> => {
      if (!source.released) {
        source.released = true;
        const current = this.sources.get(runId);
        current?.delete(source);
        if (current?.size === 0) this.sources.delete(runId);
        this.setActive(source, false);
      }
      await source.chain;
    };
    page.once('close', () => void release());
    if ((this.demand.get(runId) ?? 0) > 0) this.setActive(source, true);
    return release;
  }

  /** Tells the manager how many subscribers a run has; streaming runs only while this is above zero. */
  setDemand(runId: string, subscribers: number): void {
    if (subscribers > 0) this.demand.set(runId, subscribers);
    else this.demand.delete(runId);
    for (const s of this.sources.get(runId) ?? []) this.setActive(s, subscribers > 0);
  }

  /** Number of sources currently asked to stream (tests). */
  get activeCount(): number {
    let n = 0;
    for (const set of this.sources.values()) for (const s of set) if (s.active) n++;
    return n;
  }

  private setActive(source: Source, on: boolean): void {
    if (source.active === on) return;
    source.active = on;
    source.chain = source.chain.then(async () => {
      // Converge on the latest wish, whatever was toggled while we were busy.
      if (source.active && !source.released && !source.stop) {
        source.stop = await this.start(source).catch(() => undefined);
      } else if (!source.active && source.stop) {
        const stop = source.stop;
        source.stop = undefined;
        await stop().catch(() => undefined);
      }
    });
  }

  private emit(source: Source, data: Buffer, width: number, height: number): void {
    if (!source.active) return;
    this.o.onFrame(source.runId, { resultId: source.resultId, seq: ++source.seq, width, height, data });
  }

  private start(source: Source): Promise<() => Promise<void>> {
    const name = source.page.context().browser()?.browserType().name();
    return name === 'chromium' ? this.startCdp(source) : Promise.resolve(this.startPolling(source));
  }

  private async startCdp(source: Source): Promise<() => Promise<void>> {
    const { page } = source;
    const minGap = 1000 / this.o.maxFps;
    const session = await page.context().newCDPSession(page);
    let stopped = false;
    let lastEmit = 0;
    const timers = new Set<NodeJS.Timeout>();
    session.on('Page.screencastFrame', (f: CdpFrame) => {
      if (stopped) return;
      const began = Date.now();
      // Chromium may deliver several frames per ack window: drop the ones above the rate cap.
      if (began - lastEmit >= minGap - 1) {
        lastEmit = began;
        const vp = page.viewportSize();
        this.emit(source, Buffer.from(f.data, 'base64'), f.metadata.deviceWidth ?? vp?.width ?? 0, f.metadata.deviceHeight ?? vp?.height ?? 0);
      }
      // Chromium sends the next frame only after the ack, so delaying the ack caps the rate.
      const ack = (): void => void session.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopped) ack();
      }, Math.max(0, minGap - (Date.now() - began)));
      timers.add(timer);
    });
    await session.send('Page.startScreencast', { format: 'jpeg', quality: this.o.quality, maxWidth: this.o.maxWidth });
    return async () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      await session.send('Page.stopScreencast').catch(() => undefined);
      await session.detach().catch(() => undefined);
    };
  }

  private startPolling(source: Source): () => Promise<void> {
    let stopped = false;
    let busy = false;
    const shoot = async (): Promise<void> => {
      if (busy || stopped) return;
      busy = true;
      try {
        const data = await source.page.screenshot({ type: 'jpeg', quality: this.o.quality });
        const vp = source.page.viewportSize();
        if (!stopped) this.emit(source, data, vp?.width ?? 0, vp?.height ?? 0);
      } catch {
        // page navigating or closing; try again on the next tick
      } finally {
        busy = false;
      }
    };
    void shoot();
    const timer = setInterval(() => void shoot(), this.o.fallbackIntervalMs);
    return async () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}
