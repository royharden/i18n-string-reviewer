import { describe, expect, it } from 'vitest';
import { importFiles, loadBrokenDemo, loadDemoSet, reviewBatch, runPipeline, summarizePipeline } from '../../src/core/review/pipeline.ts';
import { createMockReviewer, parseReplyFile } from '../../src/core/review/mock.ts';
import { splitForKey } from '../../src/core/evalkit/split.ts';
import { parsePluralSuffix } from '../../src/core/l10nchecks/plural.ts';
import { allFindings, json, loadReplyCases, manifest, read } from '../maskgate/replies.ts';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('mock-only pipeline contracts (written, not executed in Dirty Mode)', () => {
  it('has a stable deterministic summary for a controlled one-item journey', async () => {
    const imported = importFiles({ source: { fileName: 'en.json', locale: 'en', dialect: 'plain', bytes: bytes('{"greeting":"Hello"}') }, targets: [{ fileName: 'fr.json', locale: 'fr', dialect: 'plain', bytes: bytes('{"greeting":"Bonjour"}') }] });
    const file = parseReplyFile({ schemaVersion: 1, set: 'tiny', replies: [{ id: 'one', locale: 'fr', key: ['greeting'], findings: [{ category: 'context_mismatch', severity: 'major', explanation: 'Recorded', evidence: 'Bonjour', suggestedFix: 'Salut' }] }] }, 'tiny.json');
    const result = await runPipeline(imported, { reviewer: createMockReviewer([file]) });
    expect(summarizePipeline(result)).toMatchInlineSnapshot(`
"reviewer: mock
file fr.json (fr): reviewed 1 item(s); export enabled
deterministic findings by rule:
model findings: 1 (supported 1, unsupported 0, with gated fix 1); dropped 0; duplicate ids 0; batches 1
gate: checked 1, accepted 1, rejected 0
gate rejections by reason:
invariant violations: 0"
`);
    expect(result.findings[0]?.suggestedFix).toBe('Salut');
  });
  for (const set of manifest.sets) {
    it(`${set.id}: planted deterministic outcomes and masked-only batches`, async () => {
      const imported = loadDemoSet(manifest, set.id, read);
      const replies = set.replies.map((p) => parseReplyFile(json(p), p));
      const mock = createMockReviewer(replies, { set: set.id });
      const result = await runPipeline(imported, { reviewer: { ...mock, review: async (batch, opts) => {
        expect(batch.length).toBeLessThanOrEqual(20); expect(JSON.stringify(batch)).not.toContain('docs-team@taskboard.example');
        return mock.review(batch, opts);
      } } });
      expect(result.invariantViolations).toEqual([]);
      for (const planted of manifest.planted.filter((p) => p.set === set.id)) {
        const ids = result.findings.filter((f) => f.locale === planted.locale && JSON.stringify(f.key) === JSON.stringify(planted.key)).map((f) => f.ruleId);
        for (const rule of planted.expect) expect(ids, planted.note).toContain(rule);
        for (const rule of planted.absent ?? []) expect(ids, planted.note).not.toContain(rule);
      }
      for (const e of imported.source.entries.values()) {
        const path = [...e.path];
        if (imported.source.dialect === 'i18next') {
          const s = parsePluralSuffix(path[path.length - 1] ?? ''); if (s) path[path.length - 1] = s.base;
        }
        expect(splitForKey(path, { seed: 20261035, dev: 0.6 }), JSON.stringify(path)).toBe('dev');
      }
    });
  }
  it('serves both branch attacks through the manifest-bound demo and exposes their gate rejections', async () => {
    // Regression: synthetic item replies are gate fixtures only; Load demo / the CLI never serves them.
    const set = manifest.sets.find((s) => s.id === 'demo-icu');
    if (!set) throw new Error('missing ICU demo set');
    const imported = loadDemoSet(manifest, set.id, read);
    const replies = set.replies.map((p) => parseReplyFile(json(p), p));
    const result = await runPipeline(imported, { reviewer: createMockReviewer(replies, { set: set.id }) });
    const summary = summarizePipeline(result);
    const split = { seed: 20261035, dev: 0.6 };
    expect(manifest.split).toMatchObject(split);
    const attacks = [
      { key: ['task', 'overdue'], reason: 'token_moved_branch' },
      { key: ['search', 'results'], reason: 'structure_changed' },
    ] as const;
    for (const attack of attacks) {
      expect(splitForKey(attack.key, split), JSON.stringify(attack.key)).toBe('dev');
      const rejections = result.rejections.filter((r) => r.locale === 'fr' && JSON.stringify(r.key) === JSON.stringify(attack.key));
      expect(rejections).toHaveLength(1);
      const rejection = rejections[0];
      expect(rejection?.reasons).toContain(attack.reason);
      const record = result.items.get(rejection?.itemId ?? '');
      expect(record?.dialect).toBe('icu');
      expect(record?.mask.fixAllowed).toBe(true);
      const finding = result.findings.find((f) => f.source === 'model' && f.id === rejection?.findingId);
      expect(finding?.evidenceStatus).toBe('supported');
      expect(finding?.suggestedFix).toBeUndefined();
      expect(result.gate.byReason[attack.reason]).toBeGreaterThan(0);
      expect(summary).toContain(`  ${attack.reason}: ${result.gate.byReason[attack.reason]}`);
    }
    expect(result.invariantViolations).toEqual([]);
  });
  it('exposes broken import report and disables model review/export', async () => {
    const imported = loadBrokenDemo(manifest, read);
    expect(imported.issues.some((i) => i.code === 'duplicate_key')).toBe(true);
    expect(imported.issues.some((i) => i.code === 'json_syntax')).toBe(true);
    expect(imported.targets[0]?.eligible).toEqual({ review: false, export: false });
    const result = await runPipeline(imported, { reviewer: { id: 'mock', label: 'Must not run', review: () => { throw new Error('reviewed an ineligible import'); } } });
    expect(result.batches).toBe(0); expect(result.files[0]?.exportEligible).toBe(false);
  });
  it('never reviews an ineligible source and rejects mismatched dialects explicitly', async () => {
    const input = { source: { fileName: 'en.json', locale: 'en', dialect: 'plain' as const, bytes: bytes('{"a":"Hello","a":"Hi","b":"World"}') }, targets: [{ fileName: 'fr.json', locale: 'fr', dialect: 'plain' as const, bytes: bytes('{"b":"Monde"}') }] };
    const result = await runPipeline(importFiles(input), { reviewer: { id: 'mock', label: 'Must not run', review: () => { throw new Error('reviewed an ineligible source'); } } });
    expect(result.batches).toBe(0);
    expect(() => importFiles({ ...input, targets: [{ ...input.targets[0]!, dialect: 'icu' }] })).toThrow(/dialect mismatch/u);
  });
  it('rejects duplicate target filenames so diagnostics cannot be bound to another locale', () => {
    expect(() => importFiles({ source: { fileName: 'en.json', locale: 'en', dialect: 'plain', bytes: bytes('{"greeting":"Hello"}') }, targets: ['fr', 'ru'].map((locale) => ({ fileName: 'common.json', locale, dialect: 'plain' as const, bytes: bytes('{"greeting":"Translated"}') })) })).toThrow(/share the filename/u);
  });
  for (const c of loadReplyCases().filter((c) => c.reply.item === undefined)) {
    it(`${c.file}/${c.reply.id}: recorded evidence/gate/drop expectations, including regeneration`, async () => {
      for (const f of allFindings(c.reply)) {
        const result = await reviewBatch([c.record], { id: 'mock', label: 'One recorded reply', review: async () => ({ rawFindings: [{ itemId: f.misdirect?.itemId ?? c.record.itemId, key: f.misdirect?.key ?? c.record.mask.masked.key, locale: f.misdirect?.locale ?? c.record.locale, category: f.category, severity: f.severity, explanation: f.explanation, evidence: f.evidence, ...(f.suggestedFix !== undefined ? { suggestedFix: f.suggestedFix } : {}) }] }) });
        if (f.expect?.dropped) { expect(result.dropped).toBe(1); expect(result.findings).toEqual([]); continue; }
        if (f.expect?.evidence) expect(result.findings[0]?.evidenceStatus).toBe(f.expect.evidence);
        if (f.expect?.gate === 'accepted') { expect(result.gate.accepted).toBe(1); expect(result.findings[0]?.suggestedFix).toBeDefined(); }
        if (f.expect?.gate === 'rejected') { expect(result.gate.rejected).toBe(1); expect(result.findings[0]?.suggestedFix).toBeUndefined(); }
        if (f.expect?.gate === 'not_gated') expect(result.gate.checked).toBe(0);
        for (const reason of f.expect?.reasons ?? []) expect(result.rejections[0]?.reasons).toContain(reason);
        expect(result.invariant).toEqual([]);
      }
    });
  }
});
