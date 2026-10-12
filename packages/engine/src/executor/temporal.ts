/** `<input>` types whose value must be in a fixed machine format (HTML "valid date string" etc.). */
export const TEMPORAL_INPUT_TYPES = ['date', 'time', 'datetime-local', 'month', 'week'] as const;
export type TemporalInputType = (typeof TEMPORAL_INPUT_TYPES)[number];

/** Format each temporal input type accepts, as shown to models and in error messages. */
export const TEMPORAL_FORMATS: Record<TemporalInputType, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH:MM (24-hour)',
  'datetime-local': 'YYYY-MM-DDTHH:MM',
  month: 'YYYY-MM',
  week: 'YYYY-Www',
};

/** True for `date`, `time`, `datetime-local`, `month` and `week`. */
export function isTemporalInputType(type: string | undefined): type is TemporalInputType {
  return (TEMPORAL_INPUT_TYPES as readonly string[]).includes(type ?? '');
}

/** Result of {@link normalizeTemporal}. Error messages never contain the value (it may come from a secret). */
export type TemporalResult = { ok: true; value: string } | { ok: false; message: string };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number, len = 2): string => String(n).padStart(len, '0');

function monthOf(name: string): number | undefined {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? undefined : i + 1;
}

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

type Part<T> = { ok: true; value: T } | { ok: false; message: string };

function parseDate(input: string): Part<string> {
  const s = input.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const ymd = (y: number, m: number, d: number): Part<string> =>
    validDay(y, m, d) ? { ok: true, value: `${pad(y, 4)}-${pad(m)}-${pad(d)}` } : { ok: false, message: 'is not a real calendar date' };

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    if (a > 12) return ymd(y, b, a); // day first
    if (b > 12) return ymd(y, a, b); // month first
    if (a === b) return ymd(y, a, b);
    return { ok: false, message: 'is ambiguous (day and month could be swapped); write it as YYYY-MM-DD' };
  }

  // 15 Jan 1990 / 15 January 1990
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.? (\d{4})$/i.exec(s);
  if (m) {
    const month = monthOf(m[2] as string);
    if (month !== undefined) return ymd(Number(m[3]), month, Number(m[1]));
  }
  // Jan 15 1990 / January 15th, 1990
  m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/i.exec(s);
  if (m) {
    const month = monthOf(m[1] as string);
    if (month !== undefined) return ymd(Number(m[3]), month, Number(m[2]));
  }
  return { ok: false, message: 'could not be read as a date' };
}

function parseTime(input: string): Part<string> {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(input.trim());
  if (!m) return { ok: false, message: 'could not be read as a time' };
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] === undefined ? undefined : Number(m[3]);
  const ampm = m[4]?.toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12) return { ok: false, message: 'is not a valid 12-hour time' };
    h = (h % 12) + (ampm === 'pm' ? 12 : 0);
  }
  if (h > 23 || min > 59 || (sec !== undefined && sec > 59)) return { ok: false, message: 'is not a valid time' };
  return { ok: true, value: `${pad(h)}:${pad(min)}${sec === undefined ? '' : `:${pad(sec)}`}` };
}

function parseMonth(input: string): Part<string> {
  const s = input.trim().replace(/\s+/g, ' ');
  const ym = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  const my = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  const year = ym?.[1] ?? my?.[2];
  const num = ym?.[2] ?? my?.[1];
  if (year !== undefined && num !== undefined) {
    const month = Number(num);
    return month >= 1 && month <= 12 ? { ok: true, value: `${year}-${pad(month)}` } : { ok: false, message: 'is not a valid month' };
  }
  const named = /^([a-z]+)\.? (\d{4})$/i.exec(s);
  const month = named ? monthOf(named[1] as string) : undefined;
  if (named && month !== undefined) return { ok: true, value: `${named[2]}-${pad(month)}` };
  return { ok: false, message: 'could not be read as a month' };
}

/**
 * Converts a human-written value into the format a temporal `<input>` accepts, e.g. `15/01/1990`
 * or `15 Jan 1990` → `1990-01-15` for `type="date"`. Day/month order is inferred only when it is
 * unambiguous (one part > 12); `01/02/1990` is rejected rather than guessed. Already-valid values
 * pass through unchanged.
 */
export function normalizeTemporal(type: TemporalInputType, value: string): TemporalResult {
  const fail = (message: string): TemporalResult => ({
    ok: false,
    message: `The ${type} field value ${message}; it needs ${TEMPORAL_FORMATS[type]}`,
  });
  switch (type) {
    case 'date': {
      const d = parseDate(value);
      return d.ok ? d : fail(d.message);
    }
    case 'time': {
      const t = parseTime(value);
      return t.ok ? t : fail(t.message);
    }
    case 'datetime-local': {
      const m = /^(.+?)[ T](\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(value.trim());
      if (!m) return fail('could not be read as a date and time');
      const d = parseDate(m[1] as string);
      if (!d.ok) return fail(d.message);
      const t = parseTime(m[2] as string);
      return t.ok ? { ok: true, value: `${d.value}T${t.value}` } : fail(t.message);
    }
    case 'month': {
      const mo = parseMonth(value);
      return mo.ok ? mo : fail(mo.message);
    }
    case 'week': {
      const m = /^(\d{4})-?W(\d{1,2})$/i.exec(value.trim());
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 53) return fail('could not be read as a week');
      return { ok: true, value: `${m[1]}-W${pad(Number(m[2]))}` };
    }
  }
}
