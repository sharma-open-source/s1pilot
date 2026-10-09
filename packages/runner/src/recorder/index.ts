export { startRecorder } from './session.js';
export type { RecorderHandle, RecorderOptions, RecorderSnapshot } from './session.js';
export { DEFAULT_GAP_MS, groupTimeline } from './group.js';
export { ValueMapper, variableKeyFor } from './values.js';
export { actionTemplate, describeStepsWithModel, stepInputs, stepTemplate } from './text.js';
export { insertResolved, recordedScript, recordedToResolved } from './learned.js';
export type { RecordedStepInput } from './learned.js';
export type {
  CapturedAction,
  DraftAction,
  DraftStep,
  KnownValues,
  RecordedKind,
  RecordingDraft,
  StepGroup,
  TimelineItem,
  VariableProposal,
} from './types.js';
