/** Base error for all expected failures in s1pilot. */
export class S1PilotError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  /**
   * @param code Stable machine-readable code, e.g. `INVALID_CASE_KEY`.
   * @param message Human-readable description (never include secret values).
   * @param details Optional structured context.
   */
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'S1PilotError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
