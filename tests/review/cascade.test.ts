import { describe, expect, it } from 'vitest';
import { createCascadeReviewer } from '../../src/core/review/cascade.ts';
import { reviewBatch } from '../../src/core/review/pipeline.ts';
import type { MaskedItem, Reviewer } from '../../src/core/review/types.ts';
import { devProbabilityFixture, probabilitiesTransport, quietProbabilities, record } from './helpers.ts';

describe('Jev → LLM composition (test sources; execution deferred)', () => {
  it('forwards only the above-threshold subset once and sums both usages', async () => {
    // what_bug_this_catches: LLM must not receive clean/equality items, duplicate flagged items, or lose either stage's tokens.
    const fixture = devProbabilityFixture.cases[0]!;
    const records = fixture.items.map((item, i) => record(`item-${i}`, item.source, item.target));
    const seen: Array<readonly MaskedItem[]> = [];
    const llm: Reviewer = { id: 'llm', label: 'Synthetic', review: async (items) => {
      seen.push(items);
      return { rawFindings: [], usage: { inputTokens: 17, outputTokens: 3 } };
    } };
    const reviewer = createCascadeReviewer({ jev: { transport: probabilitiesTransport(fixture.probabilities), allowUnmeasuredProbe: true }, llm });
    const result = await reviewer.review(records.map((r) => r.mask.masked));
    expect(seen.map((items) => items.map((item) => item.itemId))).toEqual([fixture.flaggedIndices.map((i) => `item-${i}`)]);
    expect(result.usage).toEqual({ inputTokens: 28, outputTokens: 3 });
  });

  it('makes no LLM call for an empty screen and does not call either stage by default', async () => {
    // what_bug_this_catches: a clean screen must not incur explanation calls; constructing a cascade cannot activate experimental paid work.
    const item = record('a', 'Save', 'Enregistrer').mask.masked;
    let llmCalls = 0;
    const llm: Reviewer = { id: 'llm', label: 'Synthetic', review: async () => { llmCalls++; throw new Error('must_not_call'); } };
    const probe = createCascadeReviewer({ jev: { transport: probabilitiesTransport(quietProbabilities(1)), allowUnmeasuredProbe: true }, llm });
    expect(await probe.review([item])).toEqual({ rawFindings: [], usage: { inputTokens: 11, outputTokens: 0 } });
    const disabled = createCascadeReviewer({ jev: { transport: probabilitiesTransport(quietProbabilities(1)) }, llm });
    await expect(disabled.review([item])).rejects.toThrow('jev_unmeasured_disabled');
    expect(llmCalls).toBe(0);
  });

  it('keeps hostile fixes subject to the central gate and discards claims for unselected items', async () => {
    // what_bug_this_catches: composition must not make LLM claims about screened-out items approvable or bypass placeholder preservation.
    const records = [record('flagged', 'Hello {name}', 'Bonjour {name}'), record('clean', 'Close', 'Fermer')];
    const p = { ...quietProbabilities(2), q0: 0.9 };
    const llm: Reviewer = { id: 'llm', label: 'Synthetic', review: async (items) => ({ rawFindings: [
      ...items.map((item) => ({ itemId: item.itemId, key: item.key, locale: item.locale, category: 'accuracy', severity: 'major', explanation: 'Synthetic hostile repair', evidence: 'Bonjour', suggestedFix: 'Salut' })),
      { itemId: 'clean', key: ['clean'], locale: 'fr', category: 'accuracy', severity: 'major', explanation: 'Not screened', evidence: 'Fermer', suggestedFix: 'Clore' },
    ], usage: { inputTokens: 3, outputTokens: 2 } }) };
    const result = await reviewBatch(records, createCascadeReviewer({ jev: { transport: probabilitiesTransport(p), allowUnmeasuredProbe: true }, llm }));
    expect(result.findings.map((f) => f.itemId)).toEqual(['flagged']);
    expect(result.findings[0]?.suggestedFix).toBeUndefined();
    expect(result.rejections).toHaveLength(1);
    expect(result.gate.rejected).toBe(1);
  });

  it('fails visibly on stage errors or missing explanation usage without retries', async () => {
    // what_bug_this_catches: experimental routing cannot hide failures, invent zero LLM usage, or retry a paid stage automatically.
    const item = record('a', 'Save', 'Enregistrer').mask.masked;
    let calls = 0;
    const llm: Reviewer = { id: 'llm', label: 'Synthetic', review: async () => { calls++; return { rawFindings: [] }; } };
    const reviewer = createCascadeReviewer({ jev: { transport: probabilitiesTransport({ ...quietProbabilities(1), q0: 0.9 }), allowUnmeasuredProbe: true }, llm });
    await expect(reviewer.review([item])).rejects.toThrow('missing_cascade_usage');
    expect(calls).toBe(1);
    const failed = createCascadeReviewer({ jev: { transport: async () => { throw new Error('synthetic_timeout'); }, allowUnmeasuredProbe: true }, llm });
    await expect(failed.review([item])).rejects.toThrow('synthetic_timeout');
    expect(calls).toBe(1);
  });
});
