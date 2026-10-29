import { describe, expect, it } from 'vitest';
import { scoreUnits } from '../../src/core/evalkit/metrics.ts';
import { EVAL_METHOD_IDS, renderEvaluation, sampleFixes } from '../../src/core/evalkit/render.ts';
import type { EvaluationReport, MethodEvaluation, MethodObservations, SampleFix } from '../../src/core/evalkit/render.ts';
import { ERROR_RULE_IDS, WARNING_RULE_IDS } from '../../src/core/l10nchecks/types.ts';

const report = (methods: readonly MethodEvaluation[] = []): EvaluationReport => ({ title: 'Synthetic renderer test', split: 'dev', seed: 42, versions: { rules: 'test-only' }, methods });
const observations: MethodObservations = { evidenceValid: 1, evidenceTotal: 2, proposalsAccepted: 1, proposalsRejected: 1, proposalRejectedByReason: { missing_token: 1, unknown_token: 1 }, invariantViolations: 0, invariantChecked: 1, replyCount: 2, costUsd: null, inputTokens: null, outputTokens: null, stringCount: 2 };
const fix = (index: number): SampleFix => ({ scenarioId: `proposal-${index}`, key: ['a.b', String(index)], locale: 'fr', before: 'avant', proposal: 'après', accepted: false, reasons: ['missing_token'] });

describe('honest evaluation rendering', () => {
  it('retains every mandatory method and rule row as explicit N/A when unmeasured', () => {
    // what_bug_this_catches: dropping unavailable llm rows can disguise missing accuracy evidence.
    const rendered = renderEvaluation(report([{ id: 'jev', status: 'not-measured', reason: 'No dev calibration or live call.' }]));
    for (const id of EVAL_METHOD_IDS) expect(rendered.markdown).toContain(`| ${id} |`);
    for (const id of [...ERROR_RULE_IDS, ...WARNING_RULE_IDS]) expect(rendered.markdown).toContain(`| deterministic | ${id} | N/A`);
    expect(rendered.markdown).toContain('No dev calibration or live call.');
    expect(rendered.markdown).toContain('N/A (no fix proposals were observed)');
    expect(rendered.markdown).toContain('Matched context ablation (indicative)');
    const records = rendered.jsonl.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((row) => row.kind === 'score').every((row) => row.status === 'not-measured')).toBe(true);
  });

  it('suppresses replay accuracy even if an untyped caller supplies scores', () => {
    const scores = scoreUnits({ scenarios: [], truth: [], predictions: [], labels: ['accuracy'], task: 'semantic', split: 'dev' });
    const replay = { id: 'mock', status: 'replay-only', reason: 'Recorded gate checks only.', observations, scores } as unknown as MethodEvaluation;
    const rendered = renderEvaluation(report([replay]));
    expect(rendered.markdown).toContain('| mock | accuracy | N/A (Replay/gate correctness only; no accuracy claim.)');
    expect(rendered.jsonl).not.toContain('"scores"');
    expect(() => renderEvaluation(report([{ ...replay, status: 'measured' } as unknown as MethodEvaluation]))).toThrow();
  });

  it('preserves real zeros, shows unknown cost as N/A, and never sums multi-reason rejections', () => {
    const rendered = renderEvaluation(report([{ id: 'mock', status: 'replay-only', reason: 'Recorded replies.', observations }]));
    expect(rendered.markdown).toContain('| mock | 1/2 | 1 | 1 | 0/1 | 2 |');
    expect(rendered.markdown).toContain('N/A (unknown cost)');
    expect(rendered.markdown).toContain('reason counts are not summed');
    expect(rendered.markdown).not.toContain('| mock | 1/2 | 1 | 2 |');
  });

  it('lists every named failure and gate rejection independently of the 20-proposal sample', () => {
    // what_bug_this_catches: a 20-item display cap must not silently cap the actual failure list.
    const proposals = Array.from({ length: 23 }, (_, index) => fix(index));
    const rendered = renderEvaluation(report([{ id: 'mock', status: 'replay-only', reason: 'Recorded replies.', observations, fixes: proposals }]));
    for (const proposal of proposals) expect(rendered.failuresMarkdown).toContain(`| ${proposal.scenarioId} |`);
    const records = rendered.jsonl.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((row) => row.kind === 'gate_rejection')).toHaveLength(23);
    expect(records.filter((row) => row.kind === 'sampled_fix')).toHaveLength(20);
    expect(rendered.markdown).toContain('20 of 23 distinct observed proposals');
  });

  it('samples deterministically without depending on caller order and discloses scarce samples', () => {
    const fixes = Array.from({ length: 25 }, (_, index) => ({ ...fix(index), method: 'mock' as const }));
    expect(sampleFixes(fixes, 42)).toEqual(sampleFixes([...fixes].reverse(), 42));
    expect(sampleFixes([...fixes, fixes[0]!], 42)).toHaveLength(20);
    const rendered = renderEvaluation(report([{ id: 'mock', status: 'replay-only', reason: 'Recorded replies.', fixes: [fix(1)] }]));
    expect(rendered.markdown).toContain('1 of 1 distinct observed proposals');
    expect(rendered.markdown).toContain('Fewer than 20 were available; all are shown.');
  });

  it('renders interval sample counts and leaves unobserved rule metrics N/A', () => {
    const scenarios = [{ id: 's', corpus: 'test', split: 'dev' as const, kind: 'planted' as const }];
    const truth = [{ scenarioId: 's', corpus: 'test', key: ['a'], locale: 'fr', label: 'missing_key' }];
    const scores = scoreUnits({ scenarios, truth, predictions: truth, labels: [...ERROR_RULE_IDS, ...WARNING_RULE_IDS], task: 'structural', split: 'dev' });
    const rendered = renderEvaluation(report([{ id: 'deterministic', status: 'measured', scores }]));
    expect(rendered.markdown).toContain('1.0000 (1/1; 95% [0.2065, 1.0000])');
    expect(rendered.markdown).toContain('N/A (0 denominator; 0/0)');
  });

  it('requires measured matching llm variants before rendering context comparisons', () => {
    const pair = { scenarioId: 'label-1', key: ['a'], locale: 'fr', category: 'accuracy', contextDependent: true, offDetected: false, onDetected: true };
    expect(() => renderEvaluation({ ...report(), contextPairs: [pair] })).toThrow();
    const scores = scoreUnits({ scenarios: [], truth: [], predictions: [], labels: ['accuracy'], task: 'semantic', split: 'dev' });
    const rendered = renderEvaluation({ ...report([{ id: 'llm-context-off', status: 'measured', scores }, { id: 'llm-context-on', status: 'measured', scores }]), contextPairs: [pair] });
    expect(rendered.markdown).toContain('| all matched | 1 | 0 | 0 | 1 | 0 |');
  });

  it('escapes provider text so reports remain readable text, including literal dotted paths', () => {
    const hostile = { ...fix(1), proposal: '<script>x|y</script>\nnext' };
    const rendered = renderEvaluation(report([{ id: 'mock', status: 'replay-only', reason: 'Replay.', fixes: [hostile] }]));
    expect(rendered.markdown).not.toContain('<script>');
    expect(rendered.markdown).toContain('&lt;script&gt;x&#124;y&lt;/script&gt;');
    expect(rendered.markdown).toContain('["a.b","1"]');
  });
});
