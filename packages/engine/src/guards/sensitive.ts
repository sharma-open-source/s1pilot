import type { Environment } from '@s1pilot/domain';

import type { SensitiveAction as GateSensitiveAction } from '../decide/gate.js';
import type { Observation } from '../observer/observation.js';
import type { ObservedElement } from '../observer/types.js';

import { SENSITIVE_KEYWORDS, type SensitiveClass } from './sensitive-keywords.js';

export { SENSITIVE_KEYWORDS, type SensitiveClass } from './sensitive-keywords.js';

/** Action kinds that can trigger a sensitive effect. */
const TRIGGER_KINDS = new Set(['click', 'press', 'check', 'uncheck']);
const TRIGGER_ROLES = new Set(['button', 'link', 'menuitem']);

type ClassifiableElement = Pick<ObservedElement, 'role' | 'name'> & Partial<Pick<ObservedElement, 'text' | 'landmark'>>;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `phrase` occurs in `haystack` on word boundaries (unicode-aware). */
function containsPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

function classifyText(text: string): SensitiveClass | null {
  for (const [cls, langs] of SENSITIVE_KEYWORDS) {
    for (const words of Object.values(langs)) {
      if (words.some((w) => containsPhrase(text, w))) return cls;
    }
  }
  return null;
}

/**
 * Classifies an element + action as a sensitive action, or null, using keyword lists on the
 * element's name and text. A generic confirm button ("Confirm", "Yes", "OK") inherits the class of
 * the dialog it lives in. Non-triggering actions (fill, scroll, goto, ...) are never sensitive.
 */
export function classifySensitive(
  element: ClassifiableElement,
  action: { kind: string },
  obs?: Pick<Observation, 'context'>,
): SensitiveClass | null {
  if (!TRIGGER_KINDS.has(action.kind)) return null;
  if (!TRIGGER_ROLES.has(element.role) && action.kind !== 'press') return null;
  const own = classifyText(`${element.name} ${element.text ?? ''}`);
  if (own) return own;
  if (/^(confirm|yes|ok|continue|submit)\b/i.test(element.name.trim())) {
    const hint = element.landmark?.startsWith('dialog:') ? element.landmark.slice(7) : obs?.context.dialogs.join(' ');
    if (hint) return classifyText(hint);
  }
  return null;
}

/** Aliases for step `guard` assertions such as "block submit_payment". */
const GUARD_ALIASES: Record<string, SensitiveClass> = {
  submit_payment: 'pay',
  payment: 'pay',
  pay: 'pay',
  place_order: 'pay',
  delete: 'delete',
  delete_account: 'delete',
  send: 'send',
  send_message: 'send',
  submit_order: 'submit-order',
  account_change: 'account-change',
};

/** Result of checking step guard assertions. */
export interface StepGuardResult {
  blocked: boolean;
  /** The assertion that matched. */
  rule?: string;
}

/**
 * Evaluates step `guard` assertions ("block <thing>") against the pending action. `<thing>` is
 * either a known alias (`submit_payment`, `delete_account`, ...) matched against the
 * classification, or free text (underscores = spaces) matched against the element name.
 */
export function checkStepGuards(
  guards: readonly string[],
  element: ClassifiableElement,
  classification: SensitiveClass | null,
): StepGuardResult {
  for (const rule of guards) {
    const m = /^\s*block\s+(.+?)\s*$/i.exec(rule);
    if (!m?.[1]) continue;
    const key = m[1].toLowerCase().replace(/[\s-]+/g, '_');
    const alias = GUARD_ALIASES[key];
    if (alias ? classification === alias : containsPhrase(element.name, key.replace(/_/g, ' '))) {
      return { blocked: true, rule };
    }
  }
  return { blocked: false };
}

/** Outcome of asking the sensitive guard before an action. */
export interface SensitiveCheck {
  classification: SensitiveClass | null;
  /** True when a step `guard` assertion forbids the action outright. */
  blocked: boolean;
  blockedBy?: string;
  /** Present when the gate (S-017) must be consulted before acting. */
  gate?: GateSensitiveAction;
}

/**
 * Pre-action check for the executor loop: classifies the action, applies step `guard` assertions
 * and builds the `sensitive` input for the gate. `requireApprovalFor` comes from the environment;
 * classes outside pay/delete/send (submit-order, account-change) always need approval.
 */
export function checkSensitive(
  element: ClassifiableElement,
  action: { kind: string },
  opts: {
    obs?: Pick<Observation, 'context'>;
    stepGuards?: readonly string[];
    requireApprovalFor?: Environment['requireApprovalFor'];
  } = {},
): SensitiveCheck {
  const classification = classifySensitive(element, action, opts.obs);
  const step = checkStepGuards(opts.stepGuards ?? [], element, classification);
  const result: SensitiveCheck = { classification, blocked: step.blocked };
  if (step.rule) result.blockedBy = step.rule;
  if (classification) {
    const configurable = classification === 'pay' || classification === 'delete' || classification === 'send';
    const needsApproval = !configurable || (opts.requireApprovalFor ?? ['pay', 'delete', 'send']).includes(classification);
    result.gate = { actionClass: classification, allowed: !needsApproval };
  }
  return result;
}
