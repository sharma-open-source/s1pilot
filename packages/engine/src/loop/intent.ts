/**
 * Interaction a step asks for beyond a plain click / fill, read from its wording. The model still picks
 * *which* element; the intent decides *how* it is acted on (plan section 6, action inference).
 */
export interface StepIntent {
  /** Pointer gesture for the first click-like action of the step. */
  pointer?: 'hover' | 'dblclick' | 'rightclick';
  /** The step drags something onto something else. */
  drag?: boolean;
  /** Key or chord to press, in Playwright notation (`Enter`, `Control+A`). */
  key?: string;
  /** Name of the file to upload (a quoted name with an extension, e.g. `"notes.txt"`). */
  upload?: string;
  /** The step clears a field ("clear the search"). */
  clear?: boolean;
  /** The step turns something off ("turn off autoplay", "uncheck"): checkboxes and switches are unticked. */
  off?: boolean;
}

const KEY_NAMES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};
const MODIFIERS: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
};

/** Playwright name of one key token (`esc` → `Escape`, `a` → `a`, `F5` → `F5`), or undefined. */
function keyName(token: string): string | undefined {
  const t = token.toLowerCase().replace(/[\s_-]+/g, '');
  if (KEY_NAMES[t]) return KEY_NAMES[t];
  if (/^f([1-9]|1[0-2])$/.test(t)) return t.toUpperCase();
  if (/^[a-z0-9]$/.test(t)) return t;
  return undefined;
}

/** `Ctrl+Shift+A` / `Enter` / `the Arrow Down key` → Playwright notation, or undefined. */
export function parseKey(text: string): string | undefined {
  const parts = text.trim().replace(/^the\s+/i, '').replace(/\s+key$/i, '').split(/\s*\+\s*/);
  const last = parts.pop();
  if (last === undefined) return undefined;
  const mods = parts.map((p) => MODIFIERS[p.toLowerCase()]);
  if (mods.some((m) => m === undefined)) return undefined;
  const key = keyName(last.replace(/^arrow\s+/i, 'arrow'));
  if (key === undefined) return undefined;
  return [...(mods as string[]), key].join('+');
}

const KEY_PHRASE =
  /\bpress(?:es|ing)?\s+(?:the\s+)?["']?((?:(?:ctrl|control|shift|alt|option|meta|cmd|command)\s*\+\s*)*(?:arrow\s+(?:up|down|left|right)|page\s?(?:up|down)|f\d{1,2}|[a-z]+|[a-z0-9]))["']?(?:\s+key)?/gi;
const FILE_NAME = /"([^"\\/]+\.[a-z0-9]{1,5})"/i;

/** Reads the {@link StepIntent} from a step's text (case-insensitive wording; quoted names kept as written). */
export function stepIntent(text: string): StepIntent {
  const intent: StepIntent = {};
  if (/\bdouble[\s-]?click/i.test(text)) intent.pointer = 'dblclick';
  else if (/\b(right[\s-]?click|context[\s-]?click)/i.test(text)) intent.pointer = 'rightclick';
  else if (/\b(hover|mouse\s?over|move the (mouse|pointer|cursor) (over|to|onto))/i.test(text)) intent.pointer = 'hover';
  if (/\bdrag(ged|ging|s)?\b/i.test(text)) intent.drag = true;
  if (/\b(clear|empty|erase|delete the text)\b/i.test(text)) intent.clear = true;
  if (/\b(turn(ed|s)? off|switch(ed|es)? off|un-?check|un-?tick|disable|deselect|unselect|untoggle)\b/i.test(text)) intent.off = true;
  // "Click the Press any key box and press Enter": the first phrase that names a real key wins.
  for (const m of text.matchAll(KEY_PHRASE)) {
    const parsed = m[1] ? parseKey(m[1]) : undefined;
    if (parsed) {
      intent.key = parsed;
      break;
    }
  }
  if (/\b(upload|attach|choose (a )?file|select (a )?file)/i.test(text)) {
    const file = FILE_NAME.exec(text);
    if (file?.[1]) intent.upload = file[1];
  }
  return intent;
}
