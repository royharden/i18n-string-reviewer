// SOURCE ONLY. All network calls are injected in-memory responses; no provider is contacted.
import { describe, expect, it } from 'vitest';
import { createFetchTransport } from '../../src/core/shared/transport.ts';
import { MAX_RESPONSE_BYTES } from '../../src/core/shared/wire.ts';
import { buildProviderRequest } from '../../src/core/shared/prompt.ts';
import { estimateRequest, requestHash } from '../../src/core/shared/estimate.ts';
import type { WireMaskedItem } from '../../src/core/shared/wire.ts';
const items: readonly WireMaskedItem[] = [{ itemId: 'i0', key: ['save'], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: 'Save', target: 'Enregistrer', context: 'Button', legend: [], fixAllowed: true }];
function fakeFetch(reply: unknown, onCall?: (init: RequestInit | undefined) => void): typeof fetch {
  return ((_input: unknown, init?: RequestInit) => { onCall?.(init); return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 })); }) as typeof fetch;
}
describe('direct provider contracts', () => {
  it('validates all named Jev Nouls in [0,1], with no invented confidence', async () => {
    const req = buildProviderRequest({ reviewer: 'jev', items, withContext: true });
    let calls = 0;
    const complete = createFetchTransport({ typesafeApiKey: 'synthetic-test-key', fetch: fakeFetch({ model: 'jev-1.13.0', answers: Object.fromEntries(req.questionIds.map((q) => [q, { type: 'noul', noul: 0.75 }])), usage: { input_tokens: 100, output_tokens: 5 } }, () => { calls++; }) });
    const result = await complete(req); expect(calls).toBe(1); expect(result.retries).toBe(0); expect(result.value).toEqual(Object.fromEntries(req.questionIds.map((q) => [q, 0.75]))); expect(result.rawUsage).toEqual({ input_tokens: 100, output_tokens: 5 });
  });
  it.each([{}, { q0: { type: 'noul', noul: 2 } }, { q0: { type: 'noul', noul: 0.2, confidence: 1 } }])('rejects missing/invalid named answer set', async (answers) => {
    const req = buildProviderRequest({ reviewer: 'jev', items, withContext: true });
    const complete = createFetchTransport({ typesafeApiKey: 'synthetic-test-key', fetch: fakeFetch({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 5 } }) });
    await expect(complete(req)).rejects.toThrow('malformed_response');
  });
  it('rejects wrong response model and unmeasurable usage', async () => {
    const req = buildProviderRequest({ reviewer: 'llm', items, withContext: true });
    const complete = createFetchTransport({ anthropicApiKey: 'synthetic-test-key', fetch: fakeFetch({ model: 'different', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"findings":[]}' }], usage: { input_tokens: '100', output_tokens: 5 } }) });
    await expect(complete(req)).rejects.toThrow('malformed_response');
  });
  it('accepts only completed Anthropic JSON and sends no tools', async () => {
    const req = buildProviderRequest({ reviewer: 'llm', items, withContext: true }); let sent: Record<string, unknown> | undefined;
    const complete = createFetchTransport({ anthropicApiKey: 'synthetic-test-key', fetch: fakeFetch({ model: req.modelId, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"findings":[]}' }], usage: { input_tokens: 100, output_tokens: 5 } }, (init) => { sent = JSON.parse(String(init?.body)) as Record<string, unknown>; }) });
    expect((await complete(req)).value).toEqual({ findings: [] }); expect(sent?.['max_tokens']).toBe(4096); expect(sent?.['tools']).toBeUndefined();
  });
  it('unknown model is rejected before fetch', async () => {
    let calls = 0; const req = buildProviderRequest({ reviewer: 'llm', items, withContext: true, anthropicModelId: 'unknown' });
    const complete = createFetchTransport({ anthropicApiKey: 'synthetic-test-key', fetch: fakeFetch({}, () => { calls++; }) });
    await expect(complete(req)).rejects.toThrow('model_not_priced'); expect(calls).toBe(0);
  });
  it('bounds actual response stream even with no Content-Length', async () => {
    const req = buildProviderRequest({ reviewer: 'llm', items, withContext: true });
    const complete = createFetchTransport({ anthropicApiKey: 'synthetic-test-key', fetch: (() => Promise.resolve(new Response('x'.repeat(MAX_RESPONSE_BYTES + 1)))) as typeof fetch });
    await expect(complete(req)).rejects.toThrow('response_too_large');
  });
  it('HTTP error performs no automatic retry and exposes no provider text', async () => {
    let calls = 0; const req = buildProviderRequest({ reviewer: 'llm', items, withContext: true });
    const complete = createFetchTransport({ anthropicApiKey: 'synthetic-test-key', fetch: (() => { calls++; return Promise.resolve(new Response('private provider body', { status: 429 })); }) as typeof fetch });
    await expect(complete(req)).rejects.toThrow('provider_error'); expect(calls).toBe(1);
  });
});
describe('full request estimate binding', () => {
  it('includes model, context, prompt and all batch items, rather than a single-string hash', async () => {
    const base = buildProviderRequest({ reviewer: 'llm', items, withContext: true });
    const noContext = buildProviderRequest({ reviewer: 'llm', items, withContext: false });
    const expanded = buildProviderRequest({ reviewer: 'llm', items: [...items, { ...items[0]!, itemId: 'i1', target: 'Stocker' }], withContext: true });
    expect(await requestHash(base)).not.toBe(await requestHash(noContext)); expect(await requestHash(base)).not.toBe(await requestHash(expanded));
    expect(estimateRequest(expanded).estimateUsd).toBeGreaterThan(estimateRequest(base).estimateUsd);
  });
});
