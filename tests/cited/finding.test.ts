import { expect, it } from 'vitest';
import { checkEvidence, validateModelFindings } from '../../src/core/cited/finding.ts';
import type { BatchItem } from '../../src/core/cited/finding.ts';
import { maskItem } from '../../src/core/maskgate/mask.ts';
function item(target = 'Bonjour {name}'): BatchItem {
  const m = maskItem({ itemId: 'current', path: ['greeting'], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: 'Hello {name}', target });
  return { masked: m.masked, restore: m.restore, key: ['greeting'], sourceText: 'Hello {name}', targetText: target };
}
const raw = { itemId: 'current', key: ['greeting'], locale: 'fr', category: 'accuracy', severity: 'major', explanation: 'Recorded claim', evidence: 'Bonjour', suggestedFix: 'Salut ⟦P1⟧' };
it('drops and counts cross-batch item, key and locale claims independently', async () => {
  const result = await validateModelFindings([{ ...raw, itemId: 'other-batch' }, { ...raw, key: ['foreign'] }, { ...raw, locale: 'ru' }, raw], [item()], 'mock');
  expect(result.dropped).toBe(3); expect(result.dropReasons).toMatchObject({ not_in_batch: 1, key_mismatch: 1, locale_mismatch: 1 });
  expect(result.findings).toHaveLength(1); expect(result.findings[0]?.proposalMasked).toBe('Salut ⟦P1⟧');
});
it('counts malformed replies and invalid schemas without accepting findings', async () => {
  expect((await validateModelFindings(null, [item()], 'mock')).dropReasons.malformed_reply).toBe(1);
  expect((await validateModelFindings([{}], [item()], 'mock')).dropReasons.schema).toBe(1);
});
it('restores supported evidence with a unique offset and stable finding id', async () => {
  const a = await validateModelFindings([{ ...raw, evidence: '⟦P1⟧' }], [item()], 'mock');
  const b = await validateModelFindings([{ ...raw, evidence: '⟦P1⟧' }], [item()], 'mock');
  expect(a.findings[0]?.finding).toMatchObject({ evidence: '{name}', evidenceStatus: 'supported', evidenceOffset: 8 });
  expect(a.findings[0]?.finding.id).toBe(b.findings[0]?.finding.id);
});
it.each(['Not in target', 'Bon', ''])('unsupported evidence has no approvable proposal: %s', async (evidence) => {
  const b = item(evidence === 'Bon' ? 'Bon Bon' : 'Bonjour');
  const v = await validateModelFindings([{ ...raw, evidence }], [b], 'mock');
  expect(v.findings[0]?.finding.evidenceStatus).toBe('unsupported'); expect(v.findings[0]?.proposalMasked).toBeUndefined();
});
it('rejects a unique masked token whose restored text has multiple offsets', () => {
  const b = item('{name} {name}');
  expect(checkEvidence('⟦P1⟧', b.masked.target, b.restore, b.targetText).status).toBe('unsupported');
});
it('evidence touching a whole or partial redaction token is unsupported', async () => {
  const b = item('R1 synthetic.person@example.invalid');
  for (const evidence of ['⟦R1⟧', 'R1⟧', '1']) {
    const v = await validateModelFindings([{ ...raw, evidence }], [b], 'mock');
    expect(v.findings[0]?.finding.evidenceStatus).toBe('unsupported'); expect(v.findings[0]?.proposalMasked).toBeUndefined();
  }
});
