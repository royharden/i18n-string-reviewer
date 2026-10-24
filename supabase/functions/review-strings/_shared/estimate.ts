// GENERATED from src/core/shared/ by scripts/sync-function-shared.ts. DO NOT EDIT.
import { sha256Hex } from './hash.ts';
import { actualCostUsd, PRICE_TABLE_VERSION } from './prices.ts';
import { MAX_OUTPUT_TOKENS } from './prompt.ts';
import type { ProviderRequest } from './prompt.ts';

export interface RequestEstimate { readonly estimateUsd: number; readonly inputTokens: number; readonly outputTokens: number; readonly priceTableVersion: string }
/** Conservative accounting bound, not a provider billing guarantee. Full UTF-8 payload + overhead. */
export function estimateRequest(req: ProviderRequest): RequestEstimate {
  const inputTokens = new TextEncoder().encode(JSON.stringify(req.body)).byteLength + 1024;
  const outputTokens = MAX_OUTPUT_TOKENS;
  return { estimateUsd: Math.max(0.00000001, actualCostUsd(req.provider, req.modelId, { inputTokens, outputTokens })), inputTokens, outputTokens, priceTableVersion: PRICE_TABLE_VERSION };
}
/** Whole provider request, model, prompt and price version; never a per-string hash. */
export function requestHash(req: ProviderRequest): Promise<string> {
  return sha256Hex(JSON.stringify({ promptVersion: req.promptVersion, provider: req.provider, modelId: req.modelId, body: req.body, questionIds: req.questionIds, priceTableVersion: PRICE_TABLE_VERSION }));
}
