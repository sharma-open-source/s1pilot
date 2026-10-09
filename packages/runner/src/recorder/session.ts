import { newId, S1PilotError, type Environment } from '@s1pilot/domain';
import { collectContextInPage, collectInPage, fingerprintOfParts, observer, pageFingerprint } from '@s1pilot/engine';
import type { ChatModel } from '@s1pilot/providers';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';

import { launchBrowser } from '../run-cases.js';

import { DEFAULT_GAP_MS, groupTimeline } from './group.js';
import { installRecorder, type PageRecorderConfig, type RawRecorderEvent } from './page-script.js';
import { describeStepsWithModel, stepInputs, stepTemplate } from './text.js';
import type { CapturedAction, DraftStep, KnownValues, RecordedKind, RecordingDraft, StepGroup, TimelineItem } from './types.js';
import { ValueMapper } from './values.js';

const BINDING = '__s1pilotRecord';
const STATE_BINDING = '__s1pilotRecordState';
const MARK_ATTR = 'data-s1pilot-rec';
const HOST_ID = '__s1pilot-recorder';
const MAX_TEXT = 120;
/** A navigation within this time of an action is attributed to it. */
const NAV_ATTRIBUTION_MS = 4000;

/** Options of {@link startRecorder}. */
export interface RecorderOptions {
  environment: Pick<Environment, 'baseUrl' | 'locale' | 'timezone'>;
  /** Page to open first. Default: the environment's base URL. */
  startUrl?: string;
  /** Opens the browser. Default: headed Chromium. Tests pass a headless launcher. */
  launch?: () => Promise<Browser>;
  /** Storage state of a saved login to start with. */
  storageState?: BrowserContextOptions['storageState'];
  /** Existing test data, so typed values that match become `var:` references. */
  known?: KnownValues;
  /** System 2 for the step text; without it (or when it fails) templates are used. */
  chat?: ChatModel;
  /** Start paused, so the user can navigate to the right page first and then resume (recording into the middle of a case). */
  startPaused?: boolean;
  /** Pause (ms) that starts a new step. Default 4000. */
  gapMs?: number;
  /** Called whenever the captured steps change. */
  onChange?: () => void;
  /** Called after the user pressed Stop in the floating toolbar (or closed the window) with the finished draft. */
  onStopped?: (draft: RecordingDraft) => void;
}

/** What the UI shows while recording. */
export interface RecorderSnapshot {
  state: 'recording' | 'paused' | 'stopped';
  actionCount: number;
  /** Steps captured so far, with template text. */
  steps: { id: string; action: string; expected?: string }[];
}

/** Handle to a running recording. */
export interface RecorderHandle {
  /** The recorded page (tests drive it; users use the real window). */
  readonly page: Page;
  readonly context: BrowserContext;
  snapshot(): RecorderSnapshot;
  pause(): void;
  resume(): void;
  /** Same as "Add expected result" in the toolbar. */
  addExpectation(text: string): void;
  /** Stops recording, closes the browser and returns the draft. Calling it again returns the same draft. */
  stop(): Promise<RecordingDraft>;
  /** Closes the browser and drops the recording. */
  cancel(): Promise<void>;
}

const KIND_OF: Partial<Record<RawRecorderEvent['type'], RecordedKind>> = {
  click: 'click',
  fill: 'fill',
  selectOption: 'selectOption',
  check: 'check',
  uncheck: 'uncheck',
  press: 'press',
};

/**
 * Opens a (by default headed) Chromium at the environment, injects the recording script and the
 * floating toolbar, and captures clicks, typing, selections, checkboxes, key presses and navigation
 * as replayable actions (S-060). Steps are grouped by navigation, pauses and explicit expected
 * results; typed values become variable references and passwords are never read.
 */
export async function startRecorder(opts: RecorderOptions): Promise<RecorderHandle> {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const mapper = new ValueMapper(opts.known);
  const timeline: TimelineItem[] = [];
  const startUrl = opts.startUrl ?? opts.environment.baseUrl;

  const browser = await (opts.launch ?? (() => launchBrowser('chromium', { headed: true })))();
  let context: BrowserContext;
  let page: Page;
  try {
    context = await browser.newContext({
      locale: opts.environment.locale,
      timezoneId: opts.environment.timezone,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    page = await context.newPage();
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }

  let paused = opts.startPaused === true;
  let stopped = false;
  let lastActionAt = 0;
  let draftPromise: Promise<RecordingDraft> | undefined;
  const actions: CapturedAction[] = [];
  /** Page URL before each action (its destination is the next action's). */
  const preUrls = new Map<string, string>();

  /** Mirrors the pause state into the toolbar of every frame (best effort). */
  const syncToolbar = (): void => {
    for (const frame of page.frames()) {
      void frame
        .evaluate((value) => (window as unknown as Record<string, ((v: boolean) => void) | undefined>)['__s1pilotSetPaused']?.(value), paused)
        .catch(() => undefined);
    }
  };

  const changed = (): void => {
    try {
      opts.onChange?.();
    } catch {
      /* listener errors never break recording */
    }
  };

  const fingerprint = async (): Promise<string> => {
    try {
      return pageFingerprint(await observer.capture(page, { texts: false }));
    } catch {
      return 'start';
    }
  };

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const last = actions[actions.length - 1];
    if (last && !last.navigated && Date.now() - lastActionAt < NAV_ATTRIBUTION_MS) {
      last.navigated = true;
      changed();
    }
  });

  const onEvent = (e: RawRecorderEvent): void => {
    if (stopped) return;
    if (e.type === 'control') {
      if (e.cmd === 'pause') paused = true;
      else if (e.cmd === 'resume') paused = false;
      else if (e.cmd === 'stop') setTimeout(() => void stop().catch(() => undefined), 0);
      changed();
      return;
    }
    if (paused) return;
    if (e.type === 'expect') {
      const text = e.text?.trim();
      if (text) {
        timeline.push({ type: 'expect', text, ts: e.ts });
        changed();
      }
      return;
    }
    const kind = KIND_OF[e.type];
    if (!kind) return;
    const el = e.el;
    if (!el && kind !== 'press') return;
    const name = el ? el.name || el.placeholder || el.text || el.role : '';
    const action: CapturedAction = {
      id: newId(),
      ts: e.ts,
      kind,
      role: el?.role ?? 'generic',
      name,
      locators: el?.locators ?? [],
      navigated: false,
      fingerprint: e.pre ? fingerprintOfParts(e.pre) : 'start',
      postFingerprint: 'start',
    };
    if (kind === 'fill') {
      const ref = e.secret ? mapper.mapSecret(name) : e.value !== undefined ? mapper.mapValue(name, e.value) : undefined;
      if (!ref) return;
      action.valueRef = ref.valueRef;
    } else if (kind === 'selectOption') {
      if (e.value === undefined) return;
      action.valueRef = mapper.mapValue(name, e.value).valueRef;
    } else if (kind === 'press') {
      action.key = e.key ?? 'Enter';
    }
    lastActionAt = Date.now();
    if (e.pre) preUrls.set(action.id, e.pre.url);
    actions.push(action);
    timeline.push({ type: 'action', action });
    changed();
  };

  const config: PageRecorderConfig = { binding: BINDING, stateBinding: STATE_BINDING, markAttr: MARK_ATTR, hostId: HOST_ID, maxText: MAX_TEXT };
  await context.exposeBinding(BINDING, (source, payload: RawRecorderEvent) => {
    if (source.page === page) onEvent(payload);
  });
  await context.exposeBinding(STATE_BINDING, () => ({ paused }));
  await context.addInitScript({
    content: `(${installRecorder.toString()})(${JSON.stringify(config)}, ${collectInPage.toString()}, ${collectContextInPage.toString()});`,
  });

  const groups = (): StepGroup[] => groupTimeline(timeline, gapMs);

  const snapshot = (): RecorderSnapshot => ({
    state: stopped ? 'stopped' : paused ? 'paused' : 'recording',
    actionCount: actions.length,
    steps: groups().map((g) => ({
      id: g.actions[0]?.id ?? '',
      action: stepTemplate(g),
      ...(g.expected ? { expected: g.expected } : {}),
    })),
  });

  const finish = async (): Promise<RecordingDraft> => {
    // An action ends where the next one starts; the last one ends where the page is now.
    const final = await fingerprint();
    actions.forEach((a, i) => {
      a.postFingerprint = actions[i + 1]?.fingerprint ?? final;
      const next = preUrls.get(actions[i + 1]?.id ?? '') ?? page.url();
      try {
        a.urlPath = new URL(next).pathname;
      } catch {
        /* about:blank */
      }
    });
    const grouped = groups();
    let textSource: RecordingDraft['textSource'] = 'template';
    let described: Awaited<ReturnType<typeof describeStepsWithModel>> = null;
    if (opts.chat) {
      described = await describeStepsWithModel(opts.chat, grouped);
      if (described) textSource = 's2';
    }
    const steps: DraftStep[] = grouped.map((g, i) => {
      const d = described?.[i];
      const expected = d?.expected ?? g.expected;
      return {
        id: g.actions[0]?.id ?? newId(),
        action: d?.action ?? stepTemplate(g),
        ...(expected ? { expected } : {}),
        inputs: stepInputs(g),
        actions: g.actions.map((a) => ({
          kind: a.kind,
          locators: a.locators,
          ...(a.valueRef ? { valueRef: a.valueRef } : {}),
          ...(a.key ? { key: a.key } : {}),
          fingerprint: a.fingerprint,
          postFingerprint: a.postFingerprint,
          navigated: a.navigated,
        })),
      };
    });
    return { steps, variables: mapper.proposals(), textSource, startUrl };
  };

  const stop = (): Promise<RecordingDraft> => {
    if (!draftPromise) {
      stopped = true;
      draftPromise = finish().then(async (draft) => {
        await browser.close().catch(() => undefined);
        changed();
        try {
          opts.onStopped?.(draft);
        } catch {
          /* listener errors never break recording */
        }
        return draft;
      });
    }
    return draftPromise;
  };

  browser.on('disconnected', () => {
    if (!draftPromise) void stop().catch(() => undefined);
  });

  try {
    await page.goto(startUrl, { waitUntil: 'load' });
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw new S1PilotError('RECORDER_START_FAILED', `Could not open ${startUrl}: ${error instanceof Error ? error.message.split('\n')[0] : 'navigation failed'}`, { startUrl });
  }

  return {
    page,
    context,
    snapshot,
    pause: () => {
      paused = true;
      syncToolbar();
      changed();
    },
    resume: () => {
      paused = false;
      syncToolbar();
      changed();
    },
    addExpectation: (text) => {
      const t = text.trim();
      if (!t || stopped) return;
      timeline.push({ type: 'expect', text: t, ts: Date.now() });
      changed();
    },
    stop,
    cancel: async () => {
      stopped = true;
      draftPromise ??= Promise.resolve({ steps: [], variables: [], textSource: 'template', startUrl });
      await browser.close().catch(() => undefined);
    },
  };
}
