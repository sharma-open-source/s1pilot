/** One executed action as remembered for the next observation. */
export interface HistoryEntry {
  stepIndex: number;
  /** Action kind or short description, e.g. `click`, `fill`. */
  action: string;
  /** Accessible name of the target element, if any. */
  target?: string;
  /** Outcome, e.g. `ok`, `failed: timeout`. */
  result: string;
}

/** Ring buffer of the last K actions (default 5). */
export class ActionHistory {
  private entries: HistoryEntry[] = [];

  constructor(readonly capacity = 5) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  }

  /** Appends an entry, dropping the oldest beyond capacity. */
  push(entry: HistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  /** Entries oldest to newest (copy). */
  recent(): HistoryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Forgets all entries. */
  clear(): void {
    this.entries = [];
  }
}
