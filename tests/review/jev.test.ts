import { describe, expect, it } from 'vitest';
import { createJevReviewer, createJevScreen, DEFAULT_JEV_THRESHOLDS, jevThresholdConfigSchema, validateJevProbabilities } from '../../src/core/review/jev.ts';
import { reviewBatch } from '../../src/core/review/pipeline.ts';
import { probabilitiesTransport, quietProbabilities, record } from './helpers.ts';

describe('experimental Jev composition (test sources; execution deferred)', () => {
  it('defaults disabled and rejects invented measured/enabled configuration', async () => {
    // what_bug_this_catches: placeholder thresholds cannot silently activate paid experimental review or claim completed quality validation.
    let calls = 0;
    const reviewer = createJevReviewer({ transport: async () => { calls++; throw new Error('must_not_call'); } });
    await expect(reviewer.review([record('a', 'Save', 'Enregistrer').mask.masked])).rejects.toThrow('jev_unmeasured_disabled');
    expect(calls).toBe(0);
    expect(DEFAULT_JEV_THRESHOLDS.enabledLocales).toEqual([]);
    expect(jevThresholdConfigSchema.safeParse({ ...DEFAULT_JEV_THRESHOLDS, enabledLocales: ['fr'] }).success).toBe(false);
    expect(jevThresholdConfigSchema.safeParse({ ...DEFAULT_JEV_THRESHOLDS, status: 'measured' }).success).toBe(false);
  });

  it('requires all and only the batch questions with finite probabilities', () => {
    // what_bug_this_catches: missing, extra, misnumbered or non-finite answers must fail closed rather than imply a clean item.
    const valid = quietProbabilities(1);
    expect(() => validateJevProbabilities(valid, 1)).not.toThrow();
    for (const bad of [{ ...valid, q0: Number.NaN }, { ...valid, q0: Infinity }, { ...valid, q0: -0.01 },
      { ...valid, q0: 1.01 }, { ...valid, q5: 0 }, { q0: 0, q1: 0, q2: 0, q3: 0, q99: 0 }, {}]) {
      expect(() => validateJevProbabilities(bad, 1)).toThrow('invalid_jev_probabilities');
    }
  });

  it('uses strict greater-than, coalesces same-category flags and never creates a fix', async () => {
    // what_bug_this_catches: a screening probability is neither a generated repair nor a supported explanation of meaning.
    const item = record('a', 'Close the task', 'Supprimer la tâche');
    const probabilities = { q0: 0.5, q1: 0.75, q2: 0.9, q3: 0.5, q4: 0.51 };
    const options = { transport: probabilitiesTransport(probabilities), allowUnmeasuredProbe: true };
    const screen = await createJevScreen(options).screen([item.mask.masked]);
    expect(screen.flags.map((f) => f.question)).toEqual(['omits_source_content', 'adds_content_not_in_source', 'wrong_register']);
    const result = await reviewBatch([item], createJevReviewer(options));
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.suggestedFix === undefined && f.reviewer === 'jev')).toBe(true);
    expect(result.gate.checked).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 0 });
  });

  it('propagates context-off and rejects wrong reviewer or incomplete response before callbacks', async () => {
    // what_bug_this_catches: shared wire shape alone cannot establish response correspondence with a Jev screen request.
    const batch = [record('a', 'Save', 'Enregistrer').mask.masked];
    let observed = true;
    let callbacks = 0;
    const reviewer = createJevReviewer({ allowUnmeasuredProbe: true, onResponse: () => { callbacks++; },
      transport: async (request) => { observed = request.withContext; return { reviewer: 'jev', probabilities: {}, usage: { inputTokens: 1, outputTokens: 0 }, ledgerId: 'fixture' }; } });
    await expect(reviewer.review(batch, { withContext: false })).rejects.toThrow('invalid_jev_probabilities');
    expect(observed).toBe(false); expect(callbacks).toBe(0);
    const wrong = createJevReviewer({ allowUnmeasuredProbe: true,
      transport: async () => ({ reviewer: 'llm', rawFindings: [], usage: { inputTokens: 1, outputTokens: 1 }, ledgerId: 'fixture' }) });
    await expect(wrong.review(batch)).rejects.toThrow('invalid_review_response');
  });
});
