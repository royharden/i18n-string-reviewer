import { describe, expect, it } from 'vitest';
import { createGateStats, GATE_REASONS, validateFix } from '../../src/core/maskgate/gate.ts';
import { maskTarget } from '../../src/core/maskgate/mask.ts';
import { allFindings, loadReplyCases } from './replies.ts';

const cases = loadReplyCases().filter((c) => c.reply.item !== undefined);
describe('every mandatory gate reason and counter', () => {
  for (const reason of GATE_REASONS) {
    const fixture = cases.find((c) => allFindings(c.reply).some((f) => f.expect?.reasons?.includes(reason)));
    it(`${reason}: rejects and increments exactly once`, () => {
      expect(fixture, `missing fixture for ${reason}`).toBeDefined();
      const c = fixture!;
      const f = allFindings(c.reply).find((f) => f.expect?.reasons?.includes(reason))!;
      const stats = createGateStats();
      const r = validateFix(c.record.targetText, f.suggestedFix!, c.record.mask.restore, { dialect: c.record.dialect, sourceText: c.record.sourceText, notAllowed: c.record.mask.notAllowed, ...(c.record.maxLength !== undefined ? { maxLength: c.record.maxLength } : {}) }, stats);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('hostile fix accepted');
      expect(r.reasons).toContain(reason);
      expect(stats.checked).toBe(1); expect(stats.rejected).toBe(1); expect(stats.accepted).toBe(0);
      expect(stats.byReason[reason]).toBe(1);
      for (const emitted of r.reasons) expect(stats.byReason[emitted]).toBe(1);
    });
  }
  it('binds the restore map to the current target, not source', () => {
    const stats = createGateStats();
    const r = validateFix('Bonjour {other}', 'Salut ⟦P1⟧', maskTarget('Hello {name}', 'plain').restore, { dialect: 'plain', sourceText: 'Hello {name}' }, stats);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain('unmask_failed');
    expect(stats.byReason.unmask_failed).toBe(1);
  });
  it('does not exempt already long targets from the ratio cap', () => {
    const m = maskTarget('An already long target', 'plain');
    const r = validateFix(m.restore.original, 'Still long', m.restore, { dialect: 'plain', sourceText: 'Hi' });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reasons).toContain('length_ratio');
  });
  it('counts Unicode code points including markup, with maxLength authoritative', () => {
    const m = maskTarget('😀😀', 'plain');
    expect(validateFix('😀😀', '😀😀', m.restore, { dialect: 'plain', sourceText: 'a', maxLength: 2 }).ok).toBe(true);
    const tagged = maskTarget('<b>A</b>', 'plain');
    const r = validateFix('<b>A</b>', tagged.masked, tagged.restore, { dialect: 'plain', sourceText: '<b>A</b>', maxLength: 2 });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reasons).toContain('max_length');
  });
});
