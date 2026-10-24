// Structural signature of one string, for the fix gate and the headline invariant (PLAN §3.4, M3
// acceptance 2): ICU path signature (exact branch selectors, `#` placement kept), placeholder
// multiset, unindexed-printf order and the canonical tag tree. Literal text is never part of it.

import { icuPathSignature } from '../l10nchecks/icu.ts';
import { tokenizePlaceholders } from '../l10nchecks/placeholders.ts';
import { buildTagTree, canonicalTagForm } from '../l10nchecks/tags.ts';
import type { Dialect } from '../l10nchecks/types.ts';

export interface StructureSignature {
  readonly dialect: Dialect;
  /** ICU: the text parsed. Non-ICU: always true. */
  readonly parsed: boolean;
  /** ICU only: sorted multiset of encoded root-to-node paths; null when unparseable or not ICU. */
  readonly icuPaths: readonly string[] | null;
  /** Sorted identities of placeholders whose order is free. */
  readonly placeholders: readonly string[];
  /** Identities of unindexed printf placeholders, in text order. */
  readonly printfOrder: readonly string[];
  /** Order-insensitive canonical tag tree (names, nesting, attribute names, exact href/src). */
  readonly tagForm: string;
  readonly tagErrors: number;
  readonly placeholderErrors: number;
}

export function structureSignature(text: string, dialect: Dialect): StructureSignature {
  const scan = tokenizePlaceholders(text, dialect);
  const tree = buildTagTree(text);
  const icuPaths = dialect === 'icu' ? icuPathSignature(text) : null;
  return {
    dialect,
    parsed: dialect === 'icu' ? icuPaths !== null : true,
    icuPaths,
    placeholders: scan.tokens.filter((t) => !t.ordered).map((t) => t.identity).sort(),
    printfOrder: scan.tokens.filter((t) => t.ordered).map((t) => t.identity),
    tagForm: canonicalTagForm(tree.children),
    tagErrors: tree.errors.length,
    placeholderErrors: scan.errors.length,
  };
}

export function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  return sameSequence([...a].sort(), [...b].sort());
}

export interface StructureDiff {
  /** ICU path signature differs (or the baseline could not be computed). */
  readonly structure: boolean;
  /** Placeholder identities differ as a multiset (free + ordered). */
  readonly placeholders: boolean;
  /** Same unindexed printf multiset, different order. */
  readonly printfOrder: boolean;
  readonly tags: boolean;
}

export function compareStructure(current: StructureSignature, fix: StructureSignature): StructureDiff {
  const structure = current.dialect === 'icu' ? current.icuPaths === null || fix.icuPaths === null || !sameSequence(current.icuPaths, fix.icuPaths) : false;
  const placeholders =
    !sameMultiset(current.placeholders, fix.placeholders) || !sameMultiset(current.printfOrder, fix.printfOrder);
  const printfOrder = sameMultiset(current.printfOrder, fix.printfOrder) && !sameSequence(current.printfOrder, fix.printfOrder);
  const tags = current.tagForm !== fix.tagForm || fix.tagErrors > current.tagErrors;
  return { structure, placeholders, printfOrder, tags };
}

export type InvariantViolation = 'path_signature' | 'placeholders' | 'printf_order' | 'tag_tree';

/**
 * Independent check of the headline invariant for an ACCEPTED fix: equal path signature (ICU),
 * placeholder multiset and printf order, and tag tree, compared with the current target.
 */
export function invariantViolations(currentTarget: string, fixText: string, dialect: Dialect): InvariantViolation[] {
  const a = structureSignature(currentTarget, dialect);
  const b = structureSignature(fixText, dialect);
  const out: InvariantViolation[] = [];
  if (dialect === 'icu' && (a.icuPaths === null || b.icuPaths === null || !sameSequence(a.icuPaths, b.icuPaths))) out.push('path_signature');
  if (!sameMultiset(a.placeholders, b.placeholders) || !sameMultiset(a.printfOrder, b.printfOrder)) out.push('placeholders');
  else if (!sameSequence(a.printfOrder, b.printfOrder)) out.push('printf_order');
  if (a.tagForm !== b.tagForm) out.push('tag_tree');
  return out;
}
