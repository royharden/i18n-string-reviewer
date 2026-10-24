// SOURCE ONLY. Tests inject auth, accounting and provider; no deployment, DB, accounts or paid calls.
import { describe, expect, it } from 'vitest';
import { createHandler } from '../../supabase/functions/review-strings/handler.ts';
import type { AuthUser, HandlerDependencies, LedgerStatus, ReserveMetadata, Settlement } from '../../supabase/functions/review-strings/handler.ts';
import type { ProviderResult } from '../../src/core/shared/transport.ts';
import type { ReviewRequest } from '../../src/core/shared/wire.ts';
import { buildProviderRequest } from '../../src/core/shared/prompt.ts';
const id = '10000000-0000-4000-8000-000000000001';
const ledgerId = '20000000-0000-4000-8000-000000000002';
const allowedUser: AuthUser = { id, email: ' Reviewer@Example.test ', email_confirmed_at: '2026-10-24T00:00:00Z' };
const body: ReviewRequest = { requestId: id, attempt: 1, schemaVersion: 1, reviewer: 'llm', withContext: true, items: [{ itemId: 't0-k0', key: ['button'], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: 'Save', target: 'Enregistrer', context: 'A button', legend: [], fixAllowed: true }] };
function post(value: unknown = body, headers: Record<string, string> = {}): Request {
  return new Request('https://function.test/review-strings', { method: 'POST', headers: { authorization: 'Bearer verified-user-token', 'content-type': 'application/json', origin: 'https://app.test', ...headers }, body: JSON.stringify(value) });
}
function harness(options: { user?: AuthUser | null; status?: LedgerStatus; created?: boolean; configured?: boolean; complete?: HandlerDependencies['complete']; reconcileError?: boolean; model?: string } = {}) {
  const events: string[] = []; const reserves: ReserveMetadata[] = []; const settlements: Settlement[] = [];
  const result: ProviderResult = { value: { findings: [] }, usage: { inputTokens: 100, outputTokens: 10 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, latencyMs: 1, retries: 0 };
  const handler = createHandler({
    auth: { getUser() { events.push('auth'); return Promise.resolve({ data: { user: options.user === undefined ? allowedUser : options.user }, error: null }); } },
    budget: {
      reserve(m) { events.push('reserve'); reserves.push(m); return Promise.resolve({ ledgerId, status: options.status ?? 'reserved', created: options.created ?? true }); },
      reconcile(s) { events.push('reconcile'); settlements.push(s); return options.reconcileError ? Promise.reject(new Error('private provider text must not escape')) : Promise.resolve(null); },
    },
    complete: (r, opts) => { events.push('provider'); return options.complete ? options.complete(r, opts) : Promise.resolve(result); },
    config: { allowedEmails: ['reviewer@example.test'], allowedOrigins: ['https://app.test'], anonKey: 'public-anon-key', dailyBudgetUsd: 2, providerConfigured: () => options.configured ?? true, ...(options.model ? { anthropicModelId: options.model } : {}) },
    timeoutMs: 5,
  });
  return { handler, events, reserves, settlements };
}
describe('review-strings authorization and strict request', () => {
  it.each(['', 'Bearer public-anon-key'])('401 for missing/anon bearer; never gets admin/budget', async (authorization) => {
    const h = harness(); expect((await h.handler(post(body, { authorization }))).status).toBe(401); expect(h.events).toEqual([]);
  });
  it('401 for invalid verified-user lookup', async () => {
    const h = harness({ user: null }); expect((await h.handler(post())).status).toBe(401); expect(h.events).toEqual(['auth']);
  });
  it.each([{ ...allowedUser, email_confirmed_at: null }, { ...allowedUser, email: 'outsider@example.test' }])('403 before any budget/admin access', async (user) => {
    const h = harness({ user }); expect((await h.handler(post())).status).toBe(403); expect(h.events).toEqual(['auth']);
  });
  it.each([
    { ...body, items: Array.from({ length: 21 }, () => body.items[0]) },
    { ...body, schemaVersion: 2 }, { ...body, model: 'client-choice' }, { ...body, provider: 'client-choice' },
    { ...body, items: [{ ...body.items[0], locale: 'not_a_locale' }] },
    { ...body, items: [{ ...body.items[0], dialect: ['plain'] }] },
    { ...body, items: [{ ...body.items[0], extra: 'nested unknown field' }] },
  ])('400 for strict schema failure with zero reservation', async (value) => {
    const h = harness(); expect((await h.handler(post(value))).status).toBe(400); expect(h.reserves).toHaveLength(0);
  });
  it('413 enforces actual streamed bytes without Content-Length', async () => {
    const h = harness(); const value = { ...body, unexpected: 'x'.repeat(210 * 1024) };
    expect((await h.handler(post(value))).status).toBe(413); expect(h.reserves).toHaveLength(0);
  });
  it('OPTIONS preflight has all approved headers and no auth/reservation/provider', async () => {
    const h = harness(); const response = await h.handler(new Request('https://function.test', { method: 'OPTIONS', headers: { origin: 'https://app.test' } }));
    expect(response.status).toBe(204); expect(response.headers.get('access-control-allow-headers')).toContain('x-review-estimate-hash'); expect(h.events).toEqual([]);
  });
  it('rejects unlisted origins without auth/admin calls', async () => {
    const h = harness(); expect((await h.handler(post(body, { origin: 'https://other.test' }))).status).toBe(403); expect(h.events).toEqual([]);
  });
});
describe('metered call ownership and exactly-once settlement', () => {
  it('reserves BEFORE one provider call and reconciles once', async () => {
    const h = harness(); const response = await h.handler(post());
    expect(response.status).toBe(200); expect(h.events).toEqual(['auth', 'reserve', 'provider', 'reconcile']);
    expect(h.settlements).toHaveLength(1); expect(h.settlements[0]).toMatchObject({ status: 'ok', rawUsage: { input_tokens: 100, output_tokens: 10 } });
    expect(h.reserves[0]?.promptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(h.reserves)).not.toContain('Enregistrer');
  });
  it.each(['reserved', 'ok', 'unknown', 'refused_budget'] as const)('409 duplicate %s never calls or reconciles another reservation', async (status) => {
    const h = harness({ created: false, status }); expect((await h.handler(post())).status).toBe(409); expect(h.events).toEqual(['auth', 'reserve']);
  });
  it.each([['refused_budget', 'budget'], ['refused_fault', 'fault']] as const)('429 for %s without provider/settlement', async (status, reason) => {
    const h = harness({ status }); const response = await h.handler(post()); expect(response.status).toBe(429); expect(await response.json()).toEqual({ reason }); expect(h.events).toEqual(['auth', 'reserve']);
  });
  it('503 missing provider secret before reservation', async () => {
    const h = harness({ configured: false }); const response = await h.handler(post()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'provider_not_configured' }); expect(h.events).toEqual(['auth']);
  });
  it('504 timeout settles unknown/null once even if provider ignores abort', async () => {
    const h = harness({ complete: () => new Promise<ProviderResult>(() => {}) });
    expect((await h.handler(post())).status).toBe(504); expect(h.settlements).toHaveLength(1); expect(h.settlements[0]).toMatchObject({ status: 'unknown', actualUsd: null });
  });
  it('provider errors retain reservation and never echo errors or product text', async () => {
    const h = harness({ complete: () => Promise.reject(new Error('secret and private target text')) }); const response = await h.handler(post());
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('private'); expect(h.settlements).toHaveLength(1); expect(h.settlements[0]).toMatchObject({ status: 'provider_error', actualUsd: null });
  });
  it('reconcile failure reports safe accounting error and does not retry provider or reconcile', async () => {
    const h = harness({ reconcileError: true }); const response = await h.handler(post()); expect(response.status).toBe(503); expect(h.events).toEqual(['auth', 'reserve', 'provider', 'reconcile']); expect(await response.text()).not.toContain('private');
  });
});
describe('no-charge exact preview and privacy', () => {
  it('authenticates preview but makes no budget/provider call, even without provider secret', async () => {
    const h = harness({ configured: false }); const response = await h.handler(post(body, { 'x-review-mode': 'preview' }));
    expect(response.status).toBe(200); expect(h.events).toEqual(['auth']);
    const preview = await response.json() as Record<string, unknown>; expect(preview['requestHash']).toMatch(/^[0-9a-f]{64}$/u); expect(preview['stringCount']).toBe(1); expect(preview['estimateUsd']).toBeGreaterThan(0);
  });
  it('stale preview returns409 before reservation', async () => {
    const h = harness(); const response = await h.handler(post(body, { 'x-review-estimate-hash': '0'.repeat(64) })); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'stale_preview' }); expect(h.events).toEqual(['auth']);
  });
  it('same frozen preview executes; changing one item changes whole-request hash', async () => {
    const h = harness(); const preview = await (await h.handler(post(body, { 'x-review-mode': 'preview' }))).json() as { requestHash: string };
    expect((await h.handler(post(body, { 'x-review-estimate-hash': preview.requestHash }))).status).toBe(200);
    const changed = { ...body, items: [{ ...body.items[0], target: 'Stocker' }] };
    expect((await h.handler(post(changed, { 'x-review-estimate-hash': preview.requestHash }))).status).toBe(409);
    expect(h.reserves).toHaveLength(1);
  });
  it('unknown configured model fails closed in preview and execution', async () => {
    const h = harness({ model: 'unknown-model' }); expect((await h.handler(post(body, { 'x-review-mode': 'preview' }))).status).toBe(503); expect((await h.handler(post())).status).toBe(503); expect(h.reserves).toHaveLength(0);
  });
  it('re-redacts every model-visible string and keeps ledger usage numeric-only', async () => {
    const secret = 'person@example.test'; let sent = '';
    const h = harness({ complete(req) { sent = JSON.stringify(req.body); return Promise.resolve({ value: { findings: [{ explanation: secret }] }, usage: { inputTokens: 1, outputTokens: 1 }, rawUsage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 0, retries: 0 }); } });
    const item = { ...body.items[0]!, itemId: secret, key: [secret], source: secret, target: secret, context: secret, legend: [{ field: 'target' as const, token: '⟦P1⟧', kind: 'placeholder' as const, display: secret }] };
    const response = await h.handler(post({ ...body, items: [item] }));
    expect(response.status).toBe(200); expect(sent).not.toContain(secret); expect(sent).toContain('[REDACTED]'); expect(await response.text()).not.toContain(secret); expect(JSON.stringify(h.reserves)).not.toContain(secret); expect(JSON.stringify(h.settlements)).not.toContain(secret);
  });
  it('Jev question IDs are opaque, complete validated probabilities map back by question name', async () => {
    const jevBody = { ...body, reviewer: 'jev' as const };
    const req = buildProviderRequest({ reviewer: 'jev', items: body.items, withContext: true });
    const h = harness({ complete: () => Promise.resolve({ value: Object.fromEntries(req.questionIds.map((q) => [q, 0.25])), usage: { inputTokens: 1, outputTokens: 1 }, rawUsage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 0, retries: 0 }) });
    expect((await h.handler(post(jevBody))).status).toBe(200); expect(h.reserves[0]?.questionIds).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
  });
});
