import type { DecisionRecord } from '@s1pilot/domain';

const MAX_LABEL = 80;

/**
 * Display text for one option of a decision: `e29 · [textbox] Search` when the record carries a
 * readable label for it, otherwise the bare id (older records, yes/no questions).
 */
export function optionText(dec: Pick<DecisionRecord, 'optionLabels'>, id: string): string {
  const label = dec.optionLabels?.[id]?.trim();
  if (!label || label === id) return id;
  return `${id} · ${label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label}`;
}
