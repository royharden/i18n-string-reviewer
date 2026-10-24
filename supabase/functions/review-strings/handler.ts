// Pure DI edge entrypoint. Only relative, function-deployable imports.
import { estimateRequest, requestHash } from './_shared/estimate.ts';
import { buildProviderRequest } from './_shared/prompt.ts';
import type { ProviderRequest } from './_shared/prompt.ts';
import { actualCostUsd } from './_shared/prices.ts';
import { redactText } from './_shared/redact.ts';
import { ProviderError } from './_shared/transport.ts';
import type { Complete, ProviderResult } from './_shared/transport.ts';
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, parseReviewRequest, parseUsage, redactItems } from './_shared/wire.ts';
import type { PreviewResponse, ProviderId, ReviewResponse, SafeRawUsage } from './_shared/wire.ts';

export type LedgerStatus = 'reserved' | 'ok' | 'provider_error' | 'unknown' | 'refused_budget' | 'refused_fault';
export interface ReserveMetadata {
  readonly requestId: string;
  readonly attempt: number;
  readonly userId: string;
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly promptHash: string;
  readonly questionIds: readonly string[];
  readonly estimateUsd: number;
  readonly capUsd: number;
  readonly priceTableVersion: string;
}
export interface Settlement {
  readonly ledgerId: string;
  readonly status: 'ok' | 'provider_error' | 'unknown';
  readonly actualUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly rawUsage: SafeRawUsage | null;
  readonly latencyMs: number;
}
export interface BudgetPort {
  reserve(metadata: ReserveMetadata): Promise<{ readonly ledgerId: string; readonly status: LedgerStatus; readonly created: boolean }>;
  reconcile(settlement: Settlement): Promise<unknown>;
}
export interface AuthUser { readonly id: string; readonly email?: string; readonly email_confirmed_at?: string | null }
export interface HandlerDependencies {
  readonly auth: { getUser(jwt: string): Promise<{ readonly data: { readonly user: AuthUser | null }; readonly error: unknown }> };
  readonly budget: BudgetPort;
  readonly complete: Complete;
  readonly config: {
    readonly allowedEmails: readonly string[];
    readonly allowedOrigins: readonly string[];
    readonly anonKey?: string;
    readonly anthropicModelId?: string;
    readonly dailyBudgetUsd: number;
    readonly providerConfigured: (provider: ProviderId) => boolean;
  };
  readonly now?: () => number;
  /** Test DI only. Production always uses the 30-second default. */
  readonly timeoutMs?: number;
}
const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type, x-review-mode, x-review-estimate-hash';
class BodyError extends Error {
  readonly status: number;
  constructor(status: number) { super(status === 413 ? 'request_too_large' : 'invalid_request'); this.status = status; }
}
async function bodyJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > MAX_REQUEST_BYTES) { await request.body?.cancel(); throw new BodyError(413); }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) throw new BodyError(400);
  const reader = request.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0; let text = '';
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) { await reader.cancel(); throw new BodyError(413); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) { if (error instanceof BodyError) throw error; throw new BodyError(400); }
  finally { reader.releaseLock(); }
}
/** No arbitrary provider object or text can enter accounting. All returned text is redacted again. */
function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new ProviderError('malformed_response');
  if (typeof value === 'string') return redactText(value).text;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) { if (value.length > 4000) throw new ProviderError('malformed_response'); return value.map((v) => safeValue(v, depth + 1)); }
  if (typeof value !== 'object') throw new ProviderError('malformed_response');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(value);
  if (entries.length > 4000) throw new ProviderError('malformed_response');
  for (const [key, entry] of entries) result[redactText(key).text] = safeValue(entry, depth + 1);
  return result;
}
function probabilities(value: unknown, req: ProviderRequest): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('malformed_response');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== req.questionIds.length) throw new ProviderError('malformed_response');
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const id of req.questionIds) {
    const n = o[id]; if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) throw new ProviderError('malformed_response');
    result[id] = n;
  }
  return result;
}
/** A race enforces the deadline even when an injected adapter ignores AbortSignal. */
async function completeOnce(deps: HandlerDependencies, req: ProviderRequest): Promise<ProviderResult> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProviderError('timeout')); }, deps.timeoutMs ?? 30000); });
  try { return await Promise.race([deps.complete(req, { signal: controller.signal }), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
export function createHandler(deps: HandlerDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get('origin');
    const allowedOrigin = origin !== null && deps.config.allowedOrigins.includes(origin);
    const cors: Record<string, string> = { vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': ALLOW_HEADERS };
    if (allowedOrigin && origin !== null) cors['access-control-allow-origin'] = origin;
    const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    if (origin !== null && !allowedOrigin) return json(403, { error: 'origin_forbidden' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });

    // Verified user and confirmed, exact email allowlist BEFORE any admin/budget operation.
    const bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/iu)?.[1];
    if (!bearer || bearer === deps.config.anonKey) return json(401, { error: 'unauthorized' });
    let user: AuthUser | null;
    try { const result = await deps.auth.getUser(bearer); if (result.error || !result.data.user) return json(401, { error: 'unauthorized' }); user = result.data.user; }
    catch { return json(401, { error: 'unauthorized' }); }
    const email = user.email?.trim().toLowerCase();
    if (!user.email_confirmed_at || !email || !deps.config.allowedEmails.some((e) => e.trim().toLowerCase() === email)) return json(403, { error: 'forbidden' });

    let wire; let providerRequest: ProviderRequest; let estimate; let hash: string;
    try {
      wire = parseReviewRequest(await bodyJson(request));
      providerRequest = buildProviderRequest({ reviewer: wire.reviewer, items: redactItems(wire.items), withContext: wire.withContext, ...(deps.config.anthropicModelId !== undefined ? { anthropicModelId: deps.config.anthropicModelId } : {}) });
      estimate = estimateRequest(providerRequest);
      hash = await requestHash(providerRequest);
    } catch (error) {
      if (error instanceof BodyError) return json(error.status, { error: error.message });
      if (error instanceof Error && error.message === 'model_not_priced') return json(503, { error: 'model_not_priced' });
      return json(400, { error: 'invalid_request' });
    }
    const mode = request.headers.get('x-review-mode');
    if (mode !== null && mode !== 'preview') return json(400, { error: 'invalid_request' });
    if (mode === 'preview') {
      const preview: PreviewResponse = { estimateUsd: estimate.estimateUsd, modelId: providerRequest.modelId, provider: providerRequest.provider, priceTableVersion: estimate.priceTableVersion, requestHash: hash, stringCount: wire.items.length };
      return json(200, preview); // no admin client, budget access, provider configuration check or call
    }
    const expectedHash = request.headers.get('x-review-estimate-hash');
    if (expectedHash !== null && expectedHash !== hash) return json(409, { error: 'stale_preview' });
    if (!deps.config.providerConfigured(providerRequest.provider)) return json(503, { error: 'provider_not_configured' });
    if (!Number.isFinite(deps.config.dailyBudgetUsd) || deps.config.dailyBudgetUsd < 0) return json(503, { error: 'budget_not_configured' });
    let reservation;
    try { reservation = await deps.budget.reserve({ requestId: wire.requestId, attempt: wire.attempt, userId: user.id, provider: providerRequest.provider, modelId: providerRequest.modelId, promptHash: hash, questionIds: providerRequest.questionIds, estimateUsd: estimate.estimateUsd, capUsd: deps.config.dailyBudgetUsd, priceTableVersion: estimate.priceTableVersion }); }
    catch { return json(503, { error: 'accounting_unavailable' }); }
    if (!reservation.created) return json(409, { error: 'duplicate_attempt', status: reservation.status });
    if (reservation.status === 'refused_budget' || reservation.status === 'refused_fault') return json(429, { reason: reservation.status === 'refused_budget' ? 'budget' : 'fault' });
    if (reservation.status !== 'reserved') return json(503, { error: 'accounting_unavailable' });

    const clock = deps.now ?? (() => performance.now()); const start = clock();
    let settlement: Settlement = { ledgerId: reservation.ledgerId, status: 'unknown', actualUsd: null, inputTokens: null, outputTokens: null, rawUsage: null, latencyMs: 0 };
    let response: Response;
    try {
      // Exactly one paid call. A retry is a new request attempt, never an in-function loop.
      const result = await completeOnce(deps, providerRequest);
      const usage = parseUsage(result.usage);
      const actualUsd = actualCostUsd(providerRequest.provider, providerRequest.modelId, usage);
      const output: ReviewResponse = wire.reviewer === 'llm'
        ? { reviewer: 'llm', rawFindings: safeValue(result.value), usage, ledgerId: reservation.ledgerId }
        : { reviewer: 'jev', probabilities: probabilities(result.value, providerRequest), usage, ledgerId: reservation.ledgerId };
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_RESPONSE_BYTES) throw new ProviderError('response_too_large');
      settlement = { ledgerId: reservation.ledgerId, status: 'ok', actualUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, rawUsage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, latencyMs: 0 };
      response = json(200, output);
    } catch (error) {
      const timeout = error instanceof ProviderError && error.code === 'timeout';
      settlement = { ...settlement, status: timeout ? 'unknown' : 'provider_error' };
      response = json(timeout ? 504 : 502, { error: timeout ? 'provider_timeout' : 'provider_error', ledgerId: reservation.ledgerId });
    } finally {
      settlement = { ...settlement, latencyMs: Math.max(0, Math.min(2147483647, Math.round(clock() - start))) };
      try { await deps.budget.reconcile(settlement); }
      catch { response = json(503, { error: 'accounting_unavailable', ledgerId: reservation.ledgerId }); }
    }
    return response!;
  };
}
