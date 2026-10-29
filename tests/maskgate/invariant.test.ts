import { expect, it } from 'vitest';
import { validateFix } from '../../src/core/maskgate/gate.ts';
import { icuPathSignature } from '../../src/core/l10nchecks/icu.ts';
import { tokenizePlaceholders } from '../../src/core/l10nchecks/placeholders.ts';
import { buildTagTree, canonicalTagForm } from '../../src/core/l10nchecks/tags.ts';
import { allFindings, loadReplyCases } from './replies.ts';

it('every recorded proposal, including unsupported and regenerated replies, preserves current-target invariants if accepted', () => {
  let examined = 0; let accepted = 0;
  for (const { file, reply, record: r } of loadReplyCases()) {
    for (const f of allFindings(reply)) {
      if (f.suggestedFix === undefined) continue;
      examined++;
      const gate = validateFix(r.targetText, f.suggestedFix, r.mask.restore, { dialect: r.dialect, sourceText: r.sourceText, notAllowed: r.mask.notAllowed, ...(r.maxLength !== undefined ? { maxLength: r.maxLength } : {}) });
      if (!gate.ok) continue;
      accepted++;
      const label = `${file}/${reply.id}`;
      // Independent comparison: do not call gate's compareStructure/invariantViolations helper.
      if (r.dialect === 'icu') {
        expect(icuPathSignature(gate.text), label).not.toBeNull();
        expect(icuPathSignature(gate.text), label).toEqual(icuPathSignature(r.targetText));
      }
      const before = tokenizePlaceholders(r.targetText, r.dialect);
      const after = tokenizePlaceholders(gate.text, r.dialect);
      expect(after.errors, label).toEqual([]);
      expect(after.tokens.map((t) => t.identity).sort(), label).toEqual(before.tokens.map((t) => t.identity).sort());
      expect(after.tokens.filter((t) => t.ordered).map((t) => t.identity), label).toEqual(before.tokens.filter((t) => t.ordered).map((t) => t.identity));
      expect(canonicalTagForm(buildTagTree(gate.text).children), label).toBe(canonicalTagForm(buildTagTree(r.targetText).children));
    }
  }
  expect(examined).toBeGreaterThan(20);
  expect(accepted).toBeGreaterThan(0); // Prevents a vacuous all-rejected invariant.
});
