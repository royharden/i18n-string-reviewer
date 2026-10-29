import { describe, expect, it } from 'vitest';
import { buildHeuristicPolicies, createHeuristicReviewer } from '../../src/core/review/heuristic.ts';
import { reviewBatch } from '../../src/core/review/pipeline.ts';
import { record } from './helpers.ts';

describe('local heuristic floor (test sources; execution deferred)', () => {
  it('handles identical prose, DNT, shared language and structural-only strings', async () => {
    // what_bug_this_catches: brands, en→en-GB and masked placeholders must not become untranslated-prose claims.
    const records = [record('identical', 'Save task', 'Save task'), record('brand', 'TaskBoard', 'TaskBoard'),
      record('same-language', 'Save task', 'Save task', { locale: 'en-GB' }), record('tokens', '{name}', '{name}')];
    const reviewer = createHeuristicReviewer({ policies: buildHeuristicPolicies(records, [{ term: 'TaskBoard', doNotTranslate: true }]) });
    const result = await reviewBatch(records, reviewer);
    expect(result.findings.map((f) => f.itemId)).toEqual(['identical']);
    expect(result.findings[0]).toMatchObject({ source: 'static', reviewer: 'heuristic', evidenceStatus: 'supported' });
    expect(result.findings[0]?.ruleId).toBeUndefined();
    expect(result.findings[0]?.suggestedFix).toBeUndefined();
    expect(result.gate.checked).toBe(0);
  });

  it('reports missing glossary translations/DNT and honors regional locale fallback', async () => {
    // what_bug_this_catches: local reviewer must consume trusted structured metadata rather than parsing prose from context packs.
    const records = [record('missing', 'Save TaskBoard', 'Sauver Tableau', { locale: 'fr-CA' }),
      record('approved', 'Save TaskBoard', 'Enregistrer TaskBoard', { locale: 'fr-CA' })];
    const reviewer = createHeuristicReviewer({ policies: buildHeuristicPolicies(records, [
      { term: 'Save', translations: { fr: 'Enregistrer' } }, { term: 'TaskBoard', doNotTranslate: true },
    ]) });
    const result = await reviewBatch(records, reviewer);
    expect(result.findings.filter((f) => f.category === 'terminology').map((f) => f.itemId)).toEqual(['missing']);
  });

  it('uses context limits and longest-branch visible length instead of summed plural text', async () => {
    // what_bug_this_catches: extra legitimate target plural branches must not inflate rendered-length comparisons.
    const records = [record('limit', 'Hello', 'Bonjour', { maxLength: 4 }),
      record('ratio', 'Save', 'Enregistrer la tâche'),
      record('branches', '{n, plural, one {task} other {tasks}}', '{n, plural, one {tâche} other {tâches}}', { dialect: 'icu' })];
    const reviewer = createHeuristicReviewer({ policies: buildHeuristicPolicies(records) });
    const result = await reviewBatch(records, reviewer);
    expect(result.findings.filter((f) => f.category === 'style').map((f) => f.itemId)).toEqual(['limit', 'ratio']);
  });

  it('ignores tokens and DNT in script hints and abstains for unknown script policies', async () => {
    // what_bug_this_catches: Latin mask-token names and brand names must not count as translated prose or create false script warnings.
    const records = [record('wrong', 'Save task', 'Save task', { locale: 'ru' }),
      record('right', 'Save task', 'Сохранить задачу', { locale: 'ru' }),
      record('brand', 'TaskBoard {name}', 'TaskBoard {name}', { locale: 'ja' }),
      record('unknown', 'Save task', 'Save task', { locale: 'de' })];
    const reviewer = createHeuristicReviewer({ policies: buildHeuristicPolicies(records, [{ term: 'TaskBoard', doNotTranslate: true }]) });
    const result = await reviewBatch(records, reviewer);
    expect(result.findings.filter((f) => f.category === 'fluency').map((f) => f.itemId)).toEqual(['wrong']);
  });

  it('binds local facts to the exact prepared input and leaves secret evidence unsupported', async () => {
    // what_bug_this_catches: stale trusted facts cannot be reused after editing; a local classification cannot bypass redacted-evidence validation.
    const original = record('same', 'Save task', 'Save task');
    const reviewer = createHeuristicReviewer({ policies: buildHeuristicPolicies([original]) });
    await expect(reviewer.review([record('same', 'Save task', 'Enregistrer').mask.masked])).rejects.toThrow('stale_heuristic_policy');
    const secret = record('secret', 'Email synthetic.person@example.invalid', 'Email synthetic.person@example.invalid');
    const checked = await reviewBatch([secret], createHeuristicReviewer({ policies: buildHeuristicPolicies([secret]) }));
    expect(checked.findings[0]?.evidenceStatus).toBe('unsupported');
    expect(checked.findings[0]?.source).toBe('static');
    expect(checked.findings[0]?.suggestedFix).toBeUndefined();
  });
});
