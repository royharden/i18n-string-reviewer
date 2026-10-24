// Locale-aware number extraction and normalisation (PLAN §3.2 "Numbers").
// Arabic-Indic (U+0660–0669) and Persian (U+06F0–06F9) digits become ASCII; grouping separators
// `,` `.` U+202F U+00A0 space `'` U+066C are removed when followed by exactly three digits; the
// decimal separator is chosen per locale (`1,5` is 1.5 in fr, `1.000` is 1000 in de).
// `number_drift` fires only when the normalised value multisets differ.

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;
const ARABIC_DECIMAL = '٫';
const ARABIC_THOUSANDS = '٬';

/** Map Arabic-Indic and Persian digits (and Arabic separators) to ASCII equivalents' code points. */
export function asciiDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= ARABIC_INDIC_ZERO && cp <= ARABIC_INDIC_ZERO + 9) out += String(cp - ARABIC_INDIC_ZERO);
    else if (cp >= PERSIAN_ZERO && cp <= PERSIAN_ZERO + 9) out += String(cp - PERSIAN_ZERO);
    else out += ch;
  }
  return out;
}

interface Separators {
  readonly decimal: string;
  readonly group: string;
}

const sepCache = new Map<string, Separators>();

/** The locale's decimal and grouping symbols (latn digits), with ASCII fallbacks. */
export function localeSeparators(locale: string): Separators {
  const hit = sepCache.get(locale);
  if (hit) return hit;
  let decimal = '.';
  let group = ',';
  try {
    const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(12345.6);
    decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
    group = parts.find((p) => p.type === 'group')?.value ?? ',';
  } catch {
    // keep ASCII defaults
  }
  if (decimal === ARABIC_DECIMAL) decimal = '.';
  if (group === ARABIC_THOUSANDS) group = ',';
  // Non-ASCII decimal symbols (rare) fall back to the ASCII convention for ASCII-separated runs.
  if (decimal !== '.' && decimal !== ',') decimal = '.';
  const seps = { decimal, group };
  sepCache.set(locale, seps);
  return seps;
}

const SPACE_GROUPS = new Set([' ', '\u00A0', '\u202F', "'", '’', ARABIC_THOUSANDS]);
const RUN = /\d+(?:[.,\u00A0\u202F' ’٫٬]\d+)*/gu;

function canonical(intPart: string, frac: string): string {
  const i = intPart.replace(/^0+(?=\d)/u, '');
  const f = frac.replace(/0+$/u, '');
  return f.length > 0 ? `${i}.${f}` : i;
}

/** Split one run like `1,234.5` into digit groups and separators, then normalise to values. */
function normaliseRun(run: string, seps: Separators): string[] {
  const groups: string[] = [];
  const separators: string[] = [];
  const re = /(\d+)([^\d]?)/gu;
  for (let m = re.exec(run); m !== null && m[0].length > 0; m = re.exec(run)) {
    groups.push(m[1] ?? '');
    if (m[2]) separators.push(m[2]);
  }
  // Decide whether the last separator is a decimal point.
  let decimalAt = -1;
  const k = separators.length - 1;
  if (k >= 0) {
    const last = separators[k] ?? '';
    const after = groups[k + 1] ?? '';
    const others = separators.slice(0, k);
    if (last === ARABIC_DECIMAL) decimalAt = k;
    else if (!SPACE_GROUPS.has(last)) {
      const differsFromOthers = others.length > 0 && others.every((s) => s !== last);
      const repeated = others.includes(last);
      if (!repeated) {
        if (after.length !== 3) decimalAt = last === seps.decimal || differsFromOthers || last === '.' ? k : -1;
        else if (differsFromOthers) decimalAt = k;
        else if (last === seps.decimal && last !== seps.group) decimalAt = k;
      }
    }
  }
  const values: string[] = [];
  let intPart = groups[0] ?? '';
  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i] ?? '';
    const next = groups[i + 1] ?? '';
    if (i === decimalAt) {
      values.push(canonical(intPart, next));
      intPart = '';
      // Anything after a decimal part would be a new number; a decimal is always the last separator.
      continue;
    }
    const groupable = next.length === 3 && (SPACE_GROUPS.has(sep) || sep === ',' || sep === '.');
    if (groupable) {
      intPart += next;
    } else {
      values.push(canonical(intPart, ''));
      intPart = next;
    }
  }
  if (intPart.length > 0) values.push(canonical(intPart, ''));
  return values;
}

/** Normalised numeric values in `text` for `locale`, in order of appearance. */
export function extractNumbers(text: string, locale: string): string[] {
  const seps = localeSeparators(locale);
  const ascii = asciiDigits(text);
  const out: string[] = [];
  for (const m of ascii.matchAll(RUN)) out.push(...normaliseRun(m[0], seps));
  return out;
}

export interface NumberComparison {
  readonly equal: boolean;
  readonly source: readonly string[];
  readonly target: readonly string[];
}

/**
 * Compare number values. `asSets` is used for messages with plural/select branches, whose
 * branch counts legitimately differ between locales.
 */
export function compareNumbers(
  sourceText: string,
  sourceLocale: string,
  targetText: string,
  targetLocale: string,
  opts: { readonly asSets?: boolean } = {},
): NumberComparison {
  const source = extractNumbers(sourceText, sourceLocale);
  const target = extractNumbers(targetText, targetLocale);
  let equal: boolean;
  if (opts.asSets === true) {
    const a = new Set(source);
    const b = new Set(target);
    equal = a.size === b.size && [...a].every((x) => b.has(x));
  } else {
    const a = [...source].sort();
    const b = [...target].sort();
    equal = a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return { equal, source, target };
}
