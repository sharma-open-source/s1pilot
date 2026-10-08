import { existsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CaptureFile, Redactor } from '@s1pilot/domain';
import type { BrowserContext, Page } from 'playwright';

/** What to capture per case instance. */
export interface CaptureOptions {
  /** PNG screenshot after each step. Default true. */
  screenshots?: boolean;
  /** Video of the case (`recordVideo`). Default false (plan setting). */
  video?: boolean;
  /** Playwright trace with screenshots and DOM snapshots. Default true. */
  trace?: boolean;
  /** Console messages and the HAR-lite network log. Default true. */
  logs?: boolean;
}

/** Colour painted over masked (secret) fields in screenshots. */
export const MASK_COLOR = '#FF00FF';

const MASK_ATTR = 'data-s1-mask';

/** One request of the HAR-lite network log. */
export interface NetworkEntry {
  url: string;
  method: string;
  status: number | null;
  durationMs: number | null;
  resourceType: string;
  failure?: string;
}

/** One console message of the console log. */
export interface ConsoleEntry {
  ts: string;
  type: string;
  text: string;
  location?: string;
}

/**
 * Takes a PNG screenshot of `page` to `file`. Fields that hold a secret (password inputs and inputs or textareas whose
 * value contains one of `secrets`) are covered with {@link MASK_COLOR} through Playwright's `mask` option, so the
 * secret never reaches the image. Returns false when the page cannot be captured (closed, crashed).
 */
export async function captureScreenshot(page: Page, file: string, secrets: readonly string[] = []): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    // Evaluated as a string: the runner is compiled without DOM typings.
    const masked = (await page.evaluate(`((attr, values) => {
      let n = 0;
      for (const field of Array.from(document.querySelectorAll('input, textarea'))) {
        const value = field.value;
        if (field.type === 'password' || (value !== '' && values.some((s) => s !== '' && value.includes(s)))) {
          field.setAttribute(attr, '1');
          n++;
        }
      }
      return n;
    })(${JSON.stringify(MASK_ATTR)}, ${JSON.stringify([...secrets])})`)) as number;
    try {
      await page.screenshot({
        path: file,
        mask: masked > 0 ? [page.locator(`[${MASK_ATTR}]`)] : [],
        maskColor: MASK_COLOR,
      });
    } finally {
      if (masked > 0) await page.evaluate(`document.querySelectorAll('[${MASK_ATTR}]').forEach((e) => e.removeAttribute('${MASK_ATTR}'))`);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Evidence capture of one case instance: step screenshots, console and network logs, the Playwright trace and the video.
 * Everything written is redacted where it is text; files land in `dir`.
 */
export class CaseCapture {
  private readonly consoleLog: ConsoleEntry[] = [];
  private readonly network: NetworkEntry[] = [];
  private readonly pages: Page[] = [];
  private tracing = false;

  constructor(
    private readonly dir: string,
    private readonly opts: Required<CaptureOptions>,
    private readonly redactor: Redactor,
    private readonly secrets: readonly string[],
  ) {}

  /** Resolves the options with their defaults. */
  static options(o: CaptureOptions = {}): Required<CaptureOptions> {
    return { screenshots: o.screenshots ?? true, video: o.video ?? false, trace: o.trace ?? true, logs: o.logs ?? true };
  }

  /** Directory Playwright records video into (pass to `newContext({ recordVideo })`). */
  get videoDir(): string {
    return join(this.dir, 'video-tmp');
  }

  /** Starts listening on the context (console, network, pages) and starts tracing. */
  async start(context: BrowserContext): Promise<void> {
    context.on('page', (p) => this.pages.push(p));
    if (this.opts.logs) {
      context.on('console', (m) => {
        const loc = m.location();
        this.consoleLog.push({
          ts: new Date().toISOString(),
          type: m.type(),
          text: this.redactor.redact(m.text()),
          ...(loc.url ? { location: this.redactor.redact(`${loc.url}:${loc.lineNumber}`) } : {}),
        });
      });
      context.on('requestfinished', (req) => {
        void req
          .response()
          .then((res) => {
            const t = req.timing();
            this.network.push({
              url: this.redactor.redact(req.url()),
              method: req.method(),
              status: res?.status() ?? null,
              durationMs: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
              resourceType: req.resourceType(),
            });
          })
          .catch(() => undefined);
      });
      context.on('requestfailed', (req) => {
        this.network.push({
          url: this.redactor.redact(req.url()),
          method: req.method(),
          status: null,
          durationMs: null,
          resourceType: req.resourceType(),
          failure: this.redactor.redact(req.failure()?.errorText ?? 'failed'),
        });
      });
    }
    if (this.opts.trace) {
      try {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        this.tracing = true;
      } catch {
        this.tracing = false;
      }
    }
  }

  /** Screenshot after step `index`; returns the file name (relative to the case directory) or undefined. */
  async screenshot(page: Page, index: number): Promise<string | undefined> {
    if (!this.opts.screenshots) return undefined;
    const name = `step-${String(index + 1).padStart(2, '0')}.png`;
    return (await captureScreenshot(page, join(this.dir, name), this.secrets)) ? name : undefined;
  }

  /** Stops tracing and writes `trace.zip` (call before closing the context). */
  async stopTrace(context: BrowserContext): Promise<void> {
    if (!this.tracing) return;
    this.tracing = false;
    try {
      await context.tracing.stop({ path: join(this.dir, 'trace.zip') });
    } catch {
      // context already closed (cancelled run): no trace
    }
  }

  /** Writes the logs and moves the video into place (call after the context is closed). Returns the case-level files. */
  async finish(): Promise<CaptureFile[]> {
    const files: CaptureFile[] = [];
    if (this.opts.trace && existsSync(join(this.dir, 'trace.zip'))) {
      files.push({ kind: 'trace', file: 'trace.zip', contentType: 'application/zip' });
    }
    if (this.opts.logs) {
      await writeFile(join(this.dir, 'console.json'), `${JSON.stringify(this.consoleLog, null, 2)}\n`);
      await writeFile(join(this.dir, 'network.json'), `${JSON.stringify({ version: 'har-lite-1', entries: this.network }, null, 2)}\n`);
      files.push(
        { kind: 'console', file: 'console.json', contentType: 'application/json' },
        { kind: 'network', file: 'network.json', contentType: 'application/json' },
      );
    }
    if (this.opts.video) {
      for (const page of this.pages) {
        try {
          const path = await page.video()?.path();
          if (path && existsSync(path)) {
            await rename(path, join(this.dir, 'video.webm'));
            files.push({ kind: 'video', file: 'video.webm', contentType: 'video/webm' });
            break;
          }
        } catch {
          // no video for this page
        }
      }
    }
    return files;
  }
}
