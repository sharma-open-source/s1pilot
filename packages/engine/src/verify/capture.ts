import type { ConsoleMessage, Download, Page, Response } from 'playwright';

/** A network response observed during a step. */
export interface CapturedResponse {
  url: string;
  method: string;
  status: number;
}

/**
 * Collects responses, console errors and downloads from a page while a step runs.
 * Create it before the step's action (`StepCapture.start(page)`), pass it to
 * `runAssertion` via the context, and `dispose()` when the step is done.
 */
export class StepCapture {
  readonly responses: CapturedResponse[] = [];
  readonly consoleErrors: string[] = [];
  readonly downloads: string[] = [];

  private readonly onResponse = (r: Response): void => {
    this.responses.push({ url: r.url(), method: r.request().method(), status: r.status() });
  };
  private readonly onConsole = (m: ConsoleMessage): void => {
    if (m.type() === 'error') this.consoleErrors.push(m.text());
  };
  private readonly onPageError = (e: Error): void => {
    this.consoleErrors.push(e.message);
  };
  private readonly onDownload = (d: Download): void => {
    this.downloads.push(d.suggestedFilename());
  };

  private constructor(private readonly page: Page) {
    page.on('response', this.onResponse);
    page.on('console', this.onConsole);
    page.on('pageerror', this.onPageError);
    page.on('download', this.onDownload);
  }

  /** Starts capturing on `page`. */
  static start(page: Page): StepCapture {
    return new StepCapture(page);
  }

  /** Stops capturing; collected data stays readable. */
  dispose(): void {
    this.page.off('response', this.onResponse);
    this.page.off('console', this.onConsole);
    this.page.off('pageerror', this.onPageError);
    this.page.off('download', this.onDownload);
  }
}
