// Single direct-fetch implementation shared by Node adapters and generated edge function.
import type { ProviderRequest } from './prompt.ts';
import { JEV_MODEL_ID } from './prompt.ts';
import { MAX_RESPONSE_BYTES, tokenCount } from './wire.ts';
import type { SafeRawUsage, Usage } from './wire.ts';
import { priceFor } from './prices.ts';

export interface CompleteOptions { readonly signal?: AbortSignal }
export interface ProviderResult {
  readonly value: unknown;
  readonly usage: Usage;
  readonly rawUsage: SafeRawUsage;
  readonly latencyMs: number;
  readonly retries: 0;
}
export type Complete = (request: ProviderRequest, options?: CompleteOptions) => Promise<ProviderResult>;
export type ProviderErrorCode = 'timeout' | 'provider_error' | 'malformed_response' | 'response_too_large' | 'provider_not_configured';
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode) { super(code); this.name = 'ProviderError'; this.code = code; }
}
export interface FetchTransportOptions {
  readonly fetch: typeof fetch;
  readonly anthropicApiKey?: string;
  readonly typesafeApiKey?: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('malformed_response');
  return value as Record<string, unknown>;
}
function usage(value: unknown): { usage: Usage; rawUsage: SafeRawUsage } {
  const o = record(value);
  try {
    const input = tokenCount(o['input_tokens']); const output = tokenCount(o['output_tokens']);
    return { usage: { inputTokens: input, outputTokens: output }, rawUsage: { input_tokens: input, output_tokens: output } };
  } catch { throw new ProviderError('malformed_response'); }
}
/** Streaming cap is authoritative even when Content-Length is missing or dishonest. */
export async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) { await response.body?.cancel(); throw new ProviderError('response_too_large'); }
  if (!response.body) throw new ProviderError('malformed_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0; let out = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new ProviderError('response_too_large'); }
      out += decoder.decode(part.value, { stream: true });
    }
    return out + decoder.decode();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('malformed_response');
  } finally { reader.releaseLock(); }
}
function parseValue(req: ProviderRequest, value: unknown): { value: unknown; usage: Usage; rawUsage: SafeRawUsage } {
  const o = record(value);
  if (o['model'] !== req.modelId) throw new ProviderError('malformed_response');
  const u = usage(o['usage']);
  if (req.provider === 'anthropic') {
    // Truncation cannot be accepted as a successful semantic review.
    if (o['stop_reason'] !== 'end_turn' || !Array.isArray(o['content'])) throw new ProviderError('malformed_response');
    const parts = o['content'].map((part) => {
      const p = record(part);
      if (p['type'] !== 'text' || typeof p['text'] !== 'string') throw new ProviderError('malformed_response');
      return p['text'];
    });
    try { return { value: JSON.parse(parts.join('')), ...u }; }
    catch { throw new ProviderError('malformed_response'); }
  }
  if (req.modelId !== JEV_MODEL_ID) throw new ProviderError('malformed_response');
  const answers = record(o['answers']);
  if (Object.keys(answers).length !== req.questionIds.length || Object.keys(answers).some((k) => !req.questionIds.includes(k))) throw new ProviderError('malformed_response');
  const probabilities: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const id of req.questionIds) {
    const answer = record(answers[id]); const n = answer['noul'];
    if (answer['type'] !== 'noul' || typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) throw new ProviderError('malformed_response');
    probabilities[id] = n;
  }
  return { value: probabilities, ...u };
}
export function createFetchTransport(options: FetchTransportOptions): Complete {
  const clock = options.now ?? (() => performance.now());
  return async (req, opts = {}) => {
    priceFor(req.provider, req.modelId); // Unknown model IDs never reach fetch, including direct Node use.
    const key = req.provider === 'anthropic' ? options.anthropicApiKey : options.typesafeApiKey;
    if (!key) throw new ProviderError('provider_not_configured');
    const start = clock(); const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 30000);
    try {
      const response = await options.fetch(req.provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.typesafe.ai/v1/systemone', {
        method: 'POST', signal: controller.signal,
        headers: req.provider === 'anthropic' ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(req.body),
        redirect: 'error',
      });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError('provider_error'); }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new ProviderError('malformed_response'); }
      return { ...parseValue(req, data), latencyMs: Math.max(0, Math.min(2147483647, Math.round(clock() - start))), retries: 0 };
    } catch (error) {
      if (timedOut || opts.signal?.aborted || controller.signal.aborted) throw new ProviderError('timeout');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('provider_error');
    } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); }
  };
}
