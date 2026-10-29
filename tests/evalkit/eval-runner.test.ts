// Source only during Dirty Mode. These tests never authorize a real provider or corpus evaluation.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditRawProposals, consumeHeldoutLock, createMeteredTransport, HELDOUT_LOCK, HELP, independentInvariant, main, parseEvalArgs, safeError, sourceKey } from '../../scripts/eval.ts';
import type { TransportEvent } from '../../scripts/eval.ts';
import { withBudgetSession } from '../../src/core/callledger/budget.ts';
import { maskItem } from '../../src/core/maskgate/mask.ts';
import type { ReviewItemRecord } from '../../src/core/review/pipeline.ts';
import { DEFAULT_ANTHROPIC_MODEL_ID } from '../../src/core/shared/prompt.ts';
import { ProviderError } from '../../src/core/shared/transport.ts';
import type { ProviderResult } from '../../src/core/shared/transport.ts';
import type { ReviewRequest } from '../../src/core/shared/wire.ts';

const temporary: string[] = [];
async function directory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 's34-eval-runner-')); temporary.push(path); return path; }
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); vi.restoreAllMocks(); });
function record(): ReviewItemRecord {
  const mask = maskItem({ itemId: 'item-1', path: ['greeting'], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: 'Hello {name}', target: 'Salut {name}' });
  return { itemId: 'item-1', key: ['greeting'], locale: 'fr', fileName: 'synthetic.json', dialect: 'plain', sourceText: 'Hello {name}', targetText: 'Salut {name}', mask };
}
function request(withContext = true): ReviewRequest {
  return { requestId: '12345678-1234-4234-8234-123456789abc', attempt: 1, schemaVersion: 1, reviewer: 'llm', withContext, items: [{ ...record().mask.masked, context: 'Greeting on the home screen.' }] };
}
const providerResult: ProviderResult = { value: { findings: [] }, usage: { inputTokens: 20, outputTokens: 10 }, rawUsage: { input_tokens: 20, output_tokens: 10 }, latencyMs: 3, retries: 0 };

describe('CLI authorization and immutable heldout location', () => {
  it('defaults to dev/mock and rejects alternate output/dataset/lock and rerun flags', () => {
    expect(parseEvalArgs([], {})).toMatchObject({ live: false, split: 'dev' });
    for (const flag of ['--force', '--rerun', '--root', '--output-dir', '--manifest', '--lock', '--cache-dir']) expect(() => parseEvalArgs([flag], {})).toThrow('unknown_option');
    expect(() => parseEvalArgs(['--live', '--live'], {})).toThrow('duplicate_option');
    expect(() => parseEvalArgs(['--split', 'all'], {})).toThrow('invalid_split');
    expect(HELDOUT_LOCK.replace(/\\/gu, '/')).toMatch(/\/i18n-string-reviewer\/results\/heldout\.lock$/u);
    expect(HELP).toContain('--split dev|heldout');
  });
  it('requires explicit finite positive cap, required key and known pinned model before evaluation', async () => {
    const key = { ANTHROPIC_API_KEY: 'synthetic-test-key' };
    for (const cap of [undefined, '', ' ', '0', '-1', 'NaN', 'Infinity', '1e-10', '1e300']) expect(() => parseEvalArgs(['--live'], { ...key, EVAL_MAX_USD: cap })).toThrow('EVAL_MAX_USD');
    expect(() => parseEvalArgs(['--live'], { EVAL_MAX_USD: '1' })).toThrow('ANTHROPIC_API_KEY_required');
    expect(() => parseEvalArgs(['--live'], { ...key, EVAL_MAX_USD: '1', ANTHROPIC_MODEL_ID: 'unknown-model' })).toThrow('model_not_priced');
    // --heldout authorization must fail before any fixture load or marker creation.
    await expect(main(['--split', 'heldout', '--live'], {})).rejects.toThrow('EVAL_MAX_USD');
    expect(parseEvalArgs(['--live'], { ...key, EVAL_MAX_USD: '0.01' }).maxUsd).toBe(0.01);
  });
  it('help is import safe and does not consume a lock or discover credentials', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await main(['--help'], {});
    expect(stdout).toHaveBeenCalledWith(HELP);
  });
  it('creates the heldout marker exclusively and leaves it after downstream failure', async () => {
    const path = join(await directory(), 'results', 'heldout.lock');
    const versions = { prompt: 'p1', rules: 'r1', thresholds: 't1', manifest: 'm1' };
    await consumeHeldoutLock(path, versions);
    await expect((async () => { throw new Error('synthetic evaluation failure'); })()).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ versions });
    await expect(consumeHeldoutLock(path, { ...versions, prompt: 'p2' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ versions });
  });
  it('normalizes i18next plural families before source-key splitting', () => {
    expect(sourceKey(['a', 'count_few'], 'i18next')).toEqual(['a', 'count']);
    expect(sourceKey(['a', 'count_ordinal_two'], 'i18next')).toEqual(['a', 'count']);
    expect(sourceKey(['a.b', 'count_few'], 'icu')).toEqual(['a.b', 'count_few']);
  });
});

describe('all-proposal gate audit', () => {
  it('audits unsupported, dropped/misdirected and regenerated proposals without making them exportable', () => {
    const item = record(); const proposal = item.mask.masked.target.replace('Salut', 'Bonjour');
    const base = { itemId: item.itemId, key: item.key, locale: item.locale, category: 'style', severity: 'minor', explanation: 'Synthetic test.', suggestedFix: proposal };
    const raw = [{ ...base, evidence: 'absent' }, { ...base, evidence: 'Salut', key: ['wrong-key'] }, { ...base, evidence: 'Salut', itemId: 'missing' }, { ...base, evidence: 'Salut', suggestedFix: 'Bonjour' }];
    const audits = auditRawProposals(raw, [item], 'synthetic-original');
    expect(audits).toHaveLength(4);
    expect(audits[0]).toMatchObject({ accepted: true, exportable: false, invariantViolations: [] });
    expect(audits[1]).toMatchObject({ accepted: true, exportable: false });
    expect(audits[2]).toMatchObject({ accepted: false, exportable: false, reasons: ['unbound_proposal'] });
    expect(audits[3]?.accepted).toBe(false);
    expect(audits[3]?.reasons).toContain('missing_token');
    const regenerated = auditRawProposals([{ ...base, evidence: 'Salut' }], [item], 'synthetic-regenerated');
    expect(regenerated[0]).toMatchObject({ accepted: true, exportable: true });
    expect(independentInvariant(item.targetText, 'Bonjour', 'plain')).toContain('placeholders');
  });
  it('audits a malformed proposal before schema filtering and excludes no-op approvals', () => {
    const item = record(); const base = { itemId: item.itemId, key: item.key, locale: item.locale, evidence: 'Salut', suggestedFix: item.mask.masked.target };
    expect(auditRawProposals([base], [item], 'bad-schema')[0]).toMatchObject({ accepted: true, exportable: false });
    expect(auditRawProposals([{ ...base, category: 'style', severity: 'minor', explanation: 'No change.' }], [item], 'no-op')[0]?.exportable).toBe(false);
  });
});

describe('metered whole-request response cache', () => {
  it('reserves durably before dispatch, writes metadata-only ledger, and replays matching cache without another dispatch', async () => {
    const root = await directory(); const cacheDir = join(root, '.cache'); const ledgerPath = join(root, 'call-ledger.jsonl'); const events: TransportEvent[] = [];
    const complete = vi.fn(async () => {
      const journal = JSON.parse(await readFile(join(cacheDir, 'eval-budget.json'), 'utf8')) as { entries: Array<{ status: string }> };
      expect(journal.entries.at(-1)?.status).toBe('reserved');
      return providerResult;
    });
    await withBudgetSession({ live: true, maxUsd: 1, cacheDir }, async (session) => {
      const transport = createMeteredTransport({ session, provider: { complete }, cacheDir, ledgerPath, modelId: DEFAULT_ANTHROPIC_MODEL_ID, events });
      const first = await transport(request()); const second = await transport(request());
      expect(first).toEqual(second); expect(complete).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.kind)).toEqual(['dispatch', 'cache-hit']);
      expect(events[1]).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 20 });
      expect(events[1]?.sourceLedgerId).toBe(events[0]?.sourceLedgerId);
      // Context ablation is a different whole request and requires a new reservation.
      await transport({ ...request(false), requestId: '12345678-1234-4234-8234-123456789abd' });
      expect(complete).toHaveBeenCalledTimes(2);
    });
    const ledger = await readFile(ledgerPath, 'utf8');
    expect(ledger).not.toContain('Salut'); expect(ledger).not.toContain('Greeting'); expect(ledger).not.toContain('synthetic-test-key');
    expect(ledger.trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(ledger.split('\n')[0]!)).toMatchObject({ status: 'ok', inputTokens: 20, outputTokens: 10, rawUsage: providerResult.rawUsage });
  });
  it('fails closed on corrupt cache instead of dispatching or silently using mock', async () => {
    const root = await directory(); const cacheDir = join(root, '.cache'); const ledgerPath = join(root, 'calls.jsonl'); const events: TransportEvent[] = [];
    const complete = vi.fn(async () => providerResult);
    await withBudgetSession({ live: true, maxUsd: 1, cacheDir }, async (session) => {
      const transport = createMeteredTransport({ session, provider: { complete }, cacheDir, ledgerPath, modelId: DEFAULT_ANTHROPIC_MODEL_ID, events });
      await transport(request());
      const [name] = await readdir(join(cacheDir, 'responses')); if (!name) throw new Error('missing test cache');
      await writeFile(join(cacheDir, 'responses', name), '{bad JSON');
      await expect(transport(request())).rejects.toThrow('invalid_response_cache');
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });
  it('retains full unknown charge and error metadata when a dispatch fails', async () => {
    const root = await directory(); const cacheDir = join(root, '.cache'); const ledgerPath = join(root, 'calls.jsonl'); const events: TransportEvent[] = [];
    await withBudgetSession({ live: true, maxUsd: 1, cacheDir }, async (session) => {
      const transport = createMeteredTransport({ session, provider: { complete: async () => { throw new ProviderError('timeout'); } }, cacheDir, ledgerPath, modelId: DEFAULT_ANTHROPIC_MODEL_ID, events });
      await expect(transport(request())).rejects.toThrow('timeout');
      expect(session.snapshot().entries[0]).toMatchObject({ status: 'unknown', costUsd: null });
      expect(session.snapshot().committedUsd).toBeGreaterThan(0);
      expect(events[0]).toMatchObject({ kind: 'error', status: 'timeout', costUsd: null });
    });
    expect(JSON.parse((await readFile(ledgerPath, 'utf8')).trim())).toMatchObject({ status: 'unknown', costUsd: null });
    expect(safeError(new Error('synthetic-private-provider-body'))).toBe('evaluation_failed');
  });
  it('rejects cache provenance that is not backed by its successful durable ledger entry', async () => {
    const root = await directory(); const cacheDir = join(root, '.cache'); const ledgerPath = join(root, 'calls.jsonl'); const events: TransportEvent[] = [];
    const complete = vi.fn(async () => providerResult);
    await withBudgetSession({ live: true, maxUsd: 1, cacheDir }, async (session) => {
      const transport = createMeteredTransport({ session, provider: { complete }, cacheDir, ledgerPath, modelId: DEFAULT_ANTHROPIC_MODEL_ID, events });
      await transport(request());
      const [name] = await readdir(join(cacheDir, 'responses')); if (!name) throw new Error('missing test cache');
      const path = join(cacheDir, 'responses', name); const cache = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      cache['sourceLedgerId'] = '12345678-1234-4234-8234-123456789abc';
      await writeFile(path, JSON.stringify(cache));
      await expect(transport(request())).rejects.toThrow('cache_provenance_mismatch');
      expect(complete).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ kind: 'error', status: 'cache_provenance_mismatch', costUsd: 0 });
    });
  });
  it('never invokes provider when durable reserve refuses the budget', async () => {
    const root = await directory(); const cacheDir = join(root, '.cache'); const ledgerPath = join(root, 'calls.jsonl'); const events: TransportEvent[] = [];
    const complete = vi.fn(async () => providerResult);
    await withBudgetSession({ live: true, maxUsd: 0.00000001, cacheDir }, async (session) => {
      const transport = createMeteredTransport({ session, provider: { complete }, cacheDir, ledgerPath, modelId: DEFAULT_ANTHROPIC_MODEL_ID, events });
      await expect(transport(request())).rejects.toThrow('refused_budget');
      expect(complete).not.toHaveBeenCalled(); expect(events[0]).toMatchObject({ status: 'refused_budget', costUsd: 0 });
    });
    expect(JSON.parse((await readFile(ledgerPath, 'utf8')).trim())).toMatchObject({ status: 'refused_budget' });
  });
});
