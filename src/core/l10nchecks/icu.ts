// ICU MessageFormat structure (PLAN §3.2 "ICU structure").
//
// Parsing uses @formatjs/icu-messageformat-parser with `ignoreTag: true` and
// `requiresOtherClause: false`: markup is handled by our own tag tokenizer (so `<a href="…">`,
// `<br>` and `<br/>` behave exactly as in the other dialects) and a missing `other` branch is a
// `plural_category_missing` finding rather than a syntax error.
//
// Path signature: the set (multiset, for the gate) of root-to-node paths. A path is a list of steps:
//   arg:<name>                      simple argument {name}
//   number:<name>:<style>           {n, number[, style]}   (date:/time: likewise)
//   plural:<name>:<cardinal|ordinal>:offset=<n>
//   select:<name>
//   case:<selector>                 branch of the enclosing plural/select (category, =N or select key)
//   #                               plural number placeholder
//   tag:<name>[ attrs]              markup tag (attribute names; href/src values exact)
// Literal text is excluded. Paths are JSON-encoded step arrays.
//
// `icuPathSignature` (exact branches, `#` kept) is what the M3 fix gate compares against the current
// target. The source-vs-target check uses `comparableIcuPaths`, which collapses plural branch
// selectors to `case:*` (branch sets legitimately differ per locale; categories are checked
// separately against Intl.PluralRules) and ignores `#` plus the nearest plural's own argument /
// number references (many languages spell the number out). The exact gate signature keeps all.

import {
  isArgumentElement,
  isDateElement,
  isLiteralElement,
  isNumberElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  isTimeElement,
  parse,
} from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { attrSignature, buildTagTree } from './tags.ts';
import type { TagTreeNode } from './tags.ts';
import type { PluralType } from './types.ts';

export type IcuAst = MessageFormatElement[];

export interface IcuParseError {
  /** formatjs ErrorKind name, e.g. MALFORMED_ARGUMENT, or EXCEPTION for anything unexpected. */
  readonly kind: string;
  readonly message: string;
  readonly offset: number;
}

export type IcuParseResult = { readonly ok: true; readonly ast: IcuAst } | { readonly ok: false; readonly error: IcuParseError };

export function parseIcu(text: string): IcuParseResult {
  try {
    const ast = parse(text, { ignoreTag: true, requiresOtherClause: false, captureLocation: true });
    return { ok: true, ast };
  } catch (e) {
    const err = e as { message?: unknown; originalMessage?: unknown; location?: { start?: { offset?: unknown } } };
    const kind = typeof err.message === 'string' && /^[A-Z_]+$/u.test(err.message) ? err.message : 'EXCEPTION';
    const offset = typeof err.location?.start?.offset === 'number' ? err.location.start.offset : 0;
    const original = typeof err.originalMessage === 'string' ? err.originalMessage : '';
    const message = `ICU syntax error ${kind} at offset ${offset}${original ? ` near "${original.slice(0, 40)}"` : ''}`;
    return { ok: false, error: { kind, message, offset } };
  }
}

type Options = Record<string, { value: MessageFormatElement[] }>;

/**
 * Branch entries of a plural/select element. A branch keyed `__proto__` would have set the
 * prototype of the parser's options object; it is recovered here so it stays ordinary data.
 */
function optionEntries(options: Options): Array<[string, MessageFormatElement[]]> {
  const out: Array<[string, MessageFormatElement[]]> = [];
  for (const key of Object.keys(options)) {
    const branch = options[key];
    if (branch && Array.isArray(branch.value)) out.push([key, branch.value]);
  }
  const proto: unknown = Object.getPrototypeOf(options);
  if (proto !== null && proto !== Object.prototype && typeof proto === 'object') {
    const v = (proto as { value?: unknown }).value;
    if (Array.isArray(v)) out.push(['__proto__', v as MessageFormatElement[]]);
  }
  return out;
}

function styleText(style: unknown): string {
  if (style === null || style === undefined) return '';
  if (typeof style === 'string') return style.trim();
  if (typeof style === 'object') {
    const s = style as { pattern?: unknown; tokens?: unknown };
    if (typeof s.pattern === 'string') return `::${s.pattern}`;
    if (Array.isArray(s.tokens)) {
      const toks = (s.tokens as Array<{ stem?: unknown; options?: unknown }>).map((t) =>
        [String(t.stem ?? ''), ...(Array.isArray(t.options) ? t.options.map(String) : [])].join('/'),
      );
      return `::${toks.join(' ')}`;
    }
  }
  return '';
}

function locOf(el: MessageFormatElement): { start: number; end: number } {
  const loc = (el as { location?: { start?: { offset?: number }; end?: { offset?: number } } }).location;
  return { start: loc?.start?.offset ?? 0, end: loc?.end?.offset ?? 0 };
}

/** The signature step for a non-literal element, or null for literals. */
export function elementStep(el: MessageFormatElement): string | null {
  if (isLiteralElement(el)) return null;
  if (isPoundElement(el)) return '#';
  if (isArgumentElement(el)) return `arg:${el.value}`;
  if (isNumberElement(el)) return `number:${el.value}:${styleText(el.style)}`;
  if (isDateElement(el)) return `date:${el.value}:${styleText(el.style)}`;
  if (isTimeElement(el)) return `time:${el.value}:${styleText(el.style)}`;
  if (isPluralElement(el)) return `plural:${el.value}:${el.pluralType ?? 'cardinal'}:offset=${el.offset ?? 0}`;
  if (isSelectElement(el)) return `select:${el.value}`;
  return `other:${String((el as { type?: unknown }).type)}`;
}

export interface IcuArgument {
  readonly name: string;
  /** string | number | date | time | plural | selectordinal | select */
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/** Every argument in the message (any depth), excluding `#` and literal text. */
export function icuArguments(ast: IcuAst): IcuArgument[] {
  const out: IcuArgument[] = [];
  const walk = (els: readonly MessageFormatElement[]): void => {
    for (const el of els) {
      const { start, end } = locOf(el);
      if (isArgumentElement(el)) out.push({ name: el.value, type: 'string', start, end });
      else if (isNumberElement(el)) out.push({ name: el.value, type: 'number', start, end });
      else if (isDateElement(el)) out.push({ name: el.value, type: 'date', start, end });
      else if (isTimeElement(el)) out.push({ name: el.value, type: 'time', start, end });
      else if (isPluralElement(el)) {
        out.push({ name: el.value, type: el.pluralType === 'ordinal' ? 'selectordinal' : 'plural', start, end });
        for (const [, branch] of optionEntries(el.options as Options)) walk(branch);
      } else if (isSelectElement(el)) {
        out.push({ name: el.value, type: 'select', start, end });
        for (const [, branch] of optionEntries(el.options as Options)) walk(branch);
      }
    }
  };
  walk(ast);
  return out;
}

export interface IcuPluralNode {
  readonly name: string;
  readonly pluralType: PluralType;
  readonly selectors: readonly string[];
  /** Steps from the root to (and including) this plural node. */
  readonly path: readonly string[];
}

export interface IcuTagIssue {
  readonly path: readonly string[];
  readonly message: string;
}

export interface IcuStructure {
  /** Multiset of JSON-encoded paths, sorted. */
  readonly paths: readonly string[];
  readonly plurals: readonly IcuPluralNode[];
  readonly selects: ReadonlyArray<{ readonly name: string; readonly keys: readonly string[]; readonly path: readonly string[] }>;
  /** Unbalanced markup inside a scope (root text or one branch). */
  readonly tagIssues: readonly IcuTagIssue[];
  /** Deepest nesting of plural/select constructs (0 = none). */
  readonly choiceDepth: number;
}

const MARK_OPEN = '\uE000';
const MARK_CLOSE = '\uE001';
const MARK_RE = /\uE000(\d+)\uE001/gu;

/** Compute the structure (signature paths, plural nodes, tag issues) of a parsed message. */
export function icuStructure(ast: IcuAst): IcuStructure {
  const paths: string[] = [];
  const plurals: IcuPluralNode[] = [];
  const selects: Array<{ name: string; keys: string[]; path: string[] }> = [];
  const tagIssues: IcuTagIssue[] = [];
  let choiceDepth = 0;

  const emitElement = (el: MessageFormatElement, prefix: readonly string[], depth: number): void => {
    const step = elementStep(el);
    if (step === null) return;
    const here = [...prefix, step];
    paths.push(JSON.stringify(here));
    if (isPluralElement(el) || isSelectElement(el)) {
      const d = depth + 1;
      if (d > choiceDepth) choiceDepth = d;
      const entries = optionEntries(el.options as Options);
      if (isPluralElement(el)) {
        plurals.push({ name: el.value, pluralType: el.pluralType === 'ordinal' ? 'ordinal' : 'cardinal', selectors: entries.map(([k]) => k), path: here });
      } else {
        selects.push({ name: el.value, keys: entries.map(([k]) => k), path: here });
      }
      for (const [key, branch] of entries) {
        const casePath = [...here, `case:${key}`];
        paths.push(JSON.stringify(casePath));
        walkScope(branch, casePath, d);
      }
    }
  };

  const walkScope = (els: readonly MessageFormatElement[], prefix: readonly string[], depth: number): void => {
    let scope = '';
    els.forEach((el, i) => {
      if (isLiteralElement(el)) scope += el.value.replace(/[\uE000\uE001]/gu, '\uFFFD');
      else scope += `${MARK_OPEN}${i}${MARK_CLOSE}`;
    });
    const tree = buildTagTree(scope);
    for (const err of tree.errors) tagIssues.push({ path: prefix, message: err.message });
    const markerValue = (raw: string): string =>
      raw.replace(MARK_RE, (_m, idx: string) => {
        const el = els[Number(idx)];
        return el ? `{${elementStep(el) ?? ''}}` : '';
      });
    const visit = (nodes: readonly TagTreeNode[], at: readonly string[]): void => {
      for (const n of nodes) {
        if (n.type === 'tag') {
          const sig = n.attrs.length > 0 ? ` ${attrSignature(n.attrs, markerValue)}` : '';
          const tagPath = [...at, `tag:${n.name}${sig}`];
          paths.push(JSON.stringify(tagPath));
          visit(n.children, tagPath);
          continue;
        }
        for (const m of n.text.matchAll(MARK_RE)) {
          const el = els[Number(m[1])];
          if (el) emitElement(el, at, depth);
        }
      }
    };
    visit(tree.children, prefix);
    // Elements whose marker sits inside a tag's attribute value (e.g. href="{url}") are not in any
    // text node; emit them at the scope level so arguments are never lost from the signature.
    for (const tag of tree.tokens) {
      for (const m of tag.raw.matchAll(MARK_RE)) {
        const el = els[Number(m[1])];
        if (el) emitElement(el, prefix, depth);
      }
    }
  };

  walkScope(ast, [], 0);
  paths.sort();
  return { paths, plurals, selects, tagIssues, choiceDepth };
}

/** Gate signature (exact branch selectors, `#` placement kept), sorted multiset of encoded paths. */
export function icuPathSignature(input: string | IcuAst): readonly string[] | null {
  let ast: IcuAst;
  if (typeof input === 'string') {
    const r = parseIcu(input);
    if (!r.ok) return null;
    ast = r.ast;
  } else {
    ast = input;
  }
  return icuStructure(ast).paths;
}

function decode(path: string): string[] {
  return JSON.parse(path) as string[];
}

/** Is the leaf an argument/number reference to the nearest enclosing plural's own value? */
function isPluralSelfReference(steps: readonly string[]): boolean {
  const leaf = steps[steps.length - 1] ?? '';
  if (!leaf.startsWith('arg:') && !leaf.startsWith('number:')) return false;
  for (let j = steps.length - 2; j >= 0; j--) {
    const step = steps[j];
    if (step === undefined || !step.startsWith('plural:') || !steps[j + 1]?.startsWith('case:')) continue;
    const name = /^plural:(.*):(?:cardinal|ordinal):offset=/u.exec(step)?.[1];
    // Stop at the nearest plural even when the name differs: an outer value is not this #.
    return name !== undefined && (leaf === `arg:${name}` || leaf.startsWith(`number:${name}:`));
  }
  return false;
}

/** Source-vs-target paths: plural selectors collapsed; # and plural self-number refs ignored. */
export function comparableIcuPaths(structure: IcuStructure): Set<string> {
  const out = new Set<string>();
  for (const encoded of structure.paths) {
    const steps = decode(encoded);
    if (steps[steps.length - 1] === '#' || isPluralSelfReference(steps)) continue;
    for (let j = 1; j < steps.length; j++) {
      const prev = steps[j - 1];
      const cur = steps[j];
      if (prev !== undefined && cur !== undefined && prev.startsWith('plural:') && cur.startsWith('case:')) steps[j] = 'case:*';
    }
    out.add(JSON.stringify(steps));
  }
  return out;
}

function humanStep(step: string): string {
  if (step === '#') return '#';
  const [kind, name, ...rest] = step.split(':');
  switch (kind) {
    case 'arg':
      return `{${step.slice(4)}}`;
    case 'number':
    case 'date':
    case 'time': {
      const style = rest.join(':');
      return `{${name}, ${kind}${style ? `, ${style}` : ''}}`;
    }
    case 'plural':
      return `{${name}, ${rest[0] === 'ordinal' ? 'selectordinal' : 'plural'}${rest[1] && rest[1] !== 'offset=0' ? ` ${rest[1]}` : ''}}`;
    case 'select':
      return `{${name}, select}`;
    case 'case':
      return `branch "${step.slice(5)}"`;
    case 'tag':
      return `<${step.slice(4)}>`;
    default:
      return step;
  }
}

/** Readable description of an encoded path, e.g. `<b> › {name}`. */
export function describeIcuPath(steps: readonly string[]): string {
  return steps.map(humanStep).join(' › ');
}

export interface IcuStructureDiff {
  /** Argument differences (names, types, styles, plural kind/offset, nesting). */
  readonly placeholder: readonly string[];
  /** Select branch keys that differ. */
  readonly select: readonly string[];
  /** Markup differences. */
  readonly tags: readonly string[];
}

const isTagStep = (step: string): boolean => step.startsWith('tag:');

/** Argument view: tag steps removed, tag-only paths dropped. Compares args and plural/select nesting. */
function argumentView(paths: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const encoded of paths) {
    const steps = decode(encoded);
    if (isTagStep(steps[steps.length - 1] ?? '')) continue;
    out.add(JSON.stringify(steps.filter((s) => !isTagStep(s))));
  }
  return out;
}

/** Markup view: every path that passes through a tag (tags themselves and whatever they wrap). */
function markupView(paths: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const encoded of paths) if (decode(encoded).some(isTagStep)) out.add(encoded);
  return out;
}

/**
 * Compare source and target structures on comparable paths, in two views so one change is one
 * finding: the argument view (tags ignored) feeds placeholder_mismatch / select_branch_mismatch;
 * the markup view (paths through a tag, including the arguments a tag wraps) feeds
 * html_tag_mismatch. Only minimal differences are reported — a differing path whose parent exists
 * on both sides — so one renamed plural argument is one difference, not one per descendant.
 */
export function diffIcuStructures(source: IcuStructure, target: IcuStructure): IcuStructureDiff {
  const s = comparableIcuPaths(source);
  const t = comparableIcuPaths(target);
  const placeholder: string[] = [];
  const select: string[] = [];
  const tags: string[] = [];

  const describe = (steps: readonly string[], inSource: boolean): string => {
    const parent = steps.slice(0, -1);
    const where = parent.length > 0 ? ` inside ${describeIcuPath(parent)}` : '';
    return `${inSource ? 'missing' : 'unexpected'} ${humanStep(steps[steps.length - 1] ?? '')}${where}`;
  };

  const sArgs = argumentView(s);
  const tArgs = argumentView(t);
  const argDiff = (encoded: string, inSource: boolean): void => {
    const steps = decode(encoded);
    const parent = steps.slice(0, -1);
    if (parent.length > 0) {
      const pk = JSON.stringify(parent);
      if (!(sArgs.has(pk) && tArgs.has(pk))) return;
    }
    const text = describe(steps, inSource);
    if ((steps[steps.length - 1] ?? '').startsWith('case:')) select.push(text);
    else placeholder.push(text);
  };
  for (const p of sArgs) if (!tArgs.has(p)) argDiff(p, true);
  for (const p of tArgs) if (!sArgs.has(p)) argDiff(p, false);

  const sTags = markupView(s);
  const tTags = markupView(t);
  const tagDiff = (encoded: string, inSource: boolean): void => {
    const steps = decode(encoded);
    const parent = steps.slice(0, -1);
    // Report only where the difference starts: the parent is outside any tag (its own structure is
    // compared in the argument view) or exists on both sides.
    if (parent.some(isTagStep)) {
      const pk = JSON.stringify(parent);
      if (!(sTags.has(pk) && tTags.has(pk))) return;
    }
    tags.push(describe(steps, inSource));
  };
  for (const p of sTags) if (!tTags.has(p)) tagDiff(p, true);
  for (const p of tTags) if (!sTags.has(p)) tagDiff(p, false);

  return { placeholder, select, tags };
}

const TAG_STRIP = /<\/?[A-Za-z0-9][^<>]*>/gu;

/** Literal text of all branches joined with U+0000 (markup removed). For numbers and letter counts. */
export function icuLiteralText(ast: IcuAst): string {
  const parts: string[] = [];
  const walk = (els: readonly MessageFormatElement[]): void => {
    for (const el of els) {
      if (isLiteralElement(el)) parts.push(el.value.replace(TAG_STRIP, '\u0000'));
      else if (isPluralElement(el) || isSelectElement(el)) {
        for (const [, branch] of optionEntries(el.options as Options)) walk(branch);
      }
    }
  };
  walk(ast);
  return parts.join('\u0000');
}

/**
 * Approximate rendered length in code points: literal text (markup removed) plus `{name}`-sized
 * arguments; a plural/select contributes its longest branch.
 */
export function icuDisplayLength(ast: IcuAst): number {
  const scopeLen = (els: readonly MessageFormatElement[]): number => {
    let n = 0;
    for (const el of els) {
      if (isLiteralElement(el)) n += [...el.value.replace(TAG_STRIP, '')].length;
      else if (isPoundElement(el)) n += 1;
      else if (isPluralElement(el) || isSelectElement(el)) {
        let best = 0;
        for (const [, branch] of optionEntries(el.options as Options)) best = Math.max(best, scopeLen(branch));
        n += best;
      } else {
        n += [...String((el as { value?: unknown }).value ?? '')].length + 2;
      }
    }
    return n;
  };
  return scopeLen(ast);
}
