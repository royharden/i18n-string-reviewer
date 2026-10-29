import { describe, expect, it } from 'vitest';
import { importFiles, preparePipeline, runPreparedPipeline } from '../../src/core/review/pipeline.ts';
import type { Reviewer } from '../../src/core/review/types.ts';

function imported() {
  const bytes = (text: string) => new TextEncoder().encode(text);
  return importFiles({ source: { fileName: 'en.json', locale: 'en', dialect: 'plain', bytes: bytes('{"a":"Book","b":"Save","c":"Close"}') }, targets: [{ fileName: 'fr.json', locale: 'fr', dialect: 'plain', bytes: bytes('{"a":"Livre","b":"Sauver","c":"Fermer"}') }] });
}

function response(batch: Parameters<Reviewer['review']>[0]) {
  return { rawFindings: batch.map((item) => ({ itemId: item.itemId, key: item.key, locale: item.locale, category: 'context_mismatch', severity: 'major', explanation: 'A recorded test claim.', evidence: item.target })) };
}

describe('prepared sequential review (source only; not executed in Dirty Mode)', () => {
  it('prepares frozen, scoped masked batches without calling a reviewer', async () => {
    // what_bug_this_catches: preview must not initiate paid calls or expand when the scope controls change.
    const locales = ['fr'];
    const prepared = await preparePipeline(imported(), { scope: { locales, keyPrefix: ['a'] }, batchSize: 1 });
    locales.push('ru');
    expect(prepared.scope.locales).toEqual(['fr']);
    expect(prepared.batches).toHaveLength(1);
    expect(prepared.batches[0]?.[0]?.key).toEqual(['a']);
    expect(Object.isFrozen(prepared.batches)).toBe(true);
    expect(Object.isFrozen(prepared.batches[0]?.[0]?.mask.masked)).toBe(true);
    expect(prepared.base.reviewer).toBeNull();
    expect(prepared.base.batches).toBe(0);
  });

  it('cancels before the next batch and keeps the completed evidence', async () => {
    // what_bug_this_catches: cancelling after one paid response must not discard it or send the next batch.
    const prepared = await preparePipeline(imported(), { batchSize: 1 });
    let calls = 0;
    let stop = false;
    const result = await runPreparedPipeline(prepared, {
      reviewer: { id: 'llm', label: 'Test only', review: async (batch) => { calls++; stop = true; return response(batch); } },
      shouldCancel: () => stop,
    });
    expect(calls).toBe(1);
    expect(result.completion).toBe('cancelled');
    expect(result.completedBatches).toBe(1);
    expect(result.totalBatches).toBe(3);
    expect(result.findings.filter((finding) => finding.source === 'model')).toHaveLength(1);
    expect(result.files[0]?.reviewedItems).toBe(1);
    expect(result.files[0]?.reviewed).toBe(false);
    expect(prepared.base.findings.filter((finding) => finding.source === 'model')).toHaveLength(0);
  });

  it('retains partial results on error and performs no retry or later call', async () => {
    // what_bug_this_catches: provider failures must be explicit and cannot silently restart/mock the paid run.
    const prepared = await preparePipeline(imported(), { batchSize: 1 });
    let calls = 0;
    const result = await runPreparedPipeline(prepared, { reviewer: { id: 'llm', label: 'Test only', review: async (batch) => {
      calls++;
      if (calls === 2) throw new Error('provider_timeout');
      return response(batch);
    } } });
    expect(calls).toBe(2);
    expect(result.completion).toBe('error');
    expect(result.error).toBe('provider_timeout');
    expect(result.completedBatches).toBe(1);
    expect(result.findings.some((finding) => finding.source === 'model')).toBe(true);
  });
});
