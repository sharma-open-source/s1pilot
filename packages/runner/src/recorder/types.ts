import type { LocatorCandidate } from '@s1pilot/domain';

/** Kinds of action the recorder captures; all of them are replayable except `press`. */
export type RecordedKind = 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press';

/** One captured user action. Typed values are replaced by a reference; secrets never appear. */
export interface CapturedAction {
  id: string;
  /** Page time (ms since epoch) when the action happened; used for pause detection. */
  ts: number;
  kind: RecordedKind;
  role: string;
  /** Accessible name of the element (or the placeholder / text when it has none). */
  name: string;
  locators: LocatorCandidate[];
  /** `var:<key>` / `secret:<key>`; never a literal. */
  valueRef?: string;
  /** Key name for `press`. */
  key?: string;
  /** True when this action made the main frame navigate. */
  navigated: boolean;
  /** Page fingerprint before the action (the previous action's `postFingerprint`). */
  fingerprint: string;
  /** Page fingerprint after the page settled. */
  postFingerprint: string;
  /** Path (no query) of the page after the action; context for System 2. */
  urlPath?: string;
}

/** Entry of the recording timeline: an action or an "expected result" the user added. */
export type TimelineItem = { type: 'action'; action: CapturedAction } | { type: 'expect'; text: string; ts: number };

/** Actions grouped into one step. */
export interface StepGroup {
  actions: CapturedAction[];
  /** Expected result typed with "Add expected result". */
  expected?: string;
}

/** A variable the recording needs: new non-secret value to store, or a secret to be filled in by the user. */
export interface VariableProposal {
  key: string;
  /** Present for non-secret variables only. */
  value?: string;
  secret: boolean;
  /** Accessible name of the field it came from. */
  field: string;
}

/** Test data already known to the project: matched by exact value so recordings reuse it. */
export interface KnownValues {
  /** Non-secret variables of the environment (key to value). */
  vars: Record<string, string>;
  /** Keys of secret variables; a password field named like one reuses it. */
  secretKeys: string[];
}

/** Replayable action of a draft step (becomes a `ResolvedAction` on save). */
export interface DraftAction {
  kind: RecordedKind;
  locators: LocatorCandidate[];
  valueRef?: string;
  key?: string;
  fingerprint: string;
  postFingerprint: string;
  navigated: boolean;
}

/** A step of the recording, ready for review. */
export interface DraftStep {
  id: string;
  /** Plain-language action text (System 2 or template). */
  action: string;
  expected?: string;
  /** Test-data keys used by the step. */
  inputs: string[];
  actions: DraftAction[];
}

/** Result of stopping a recording. Contains no secret value. */
export interface RecordingDraft {
  steps: DraftStep[];
  variables: VariableProposal[];
  /** Where the step text came from. */
  textSource: 's2' | 'template';
  /** URL the recording started at. */
  startUrl: string;
}
