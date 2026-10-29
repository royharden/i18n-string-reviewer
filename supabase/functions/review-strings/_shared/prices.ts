// GENERATED from src/core/shared/ by scripts/sync-function-shared.ts. DO NOT EDIT.
import type { ProviderId, Usage } from './wire.ts';
// Dated build assumptions, verified against public provider documentation 2026-10-24.
// Unknown IDs fail closed. No alias/latest migration. Reverify before any live run.
export const PRICE_TABLE_VERSION = '2026-10-24-v1';
export interface Price { readonly inputPerMillion: number; readonly outputPerMillion: number }
export function priceFor(provider: ProviderId, modelId: string): Price {
  if (provider === 'anthropic' && modelId === 'claude-haiku-4-5-20251001') return { inputPerMillion: 1, outputPerMillion: 5 };
  if (provider === 'typesafe' && modelId === 'jev-1.13.0') return { inputPerMillion: 0.042, outputPerMillion: 0 };
  throw new Error('model_not_priced');
}
/** Round charges upward to SQL numeric(14,8) precision; never understate through rounding. */
export function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid_cost');
  return Math.ceil(value * 100000000) / 100000000;
}
export function actualCostUsd(provider: ProviderId, modelId: string, usage: Usage): number {
  if (![usage.inputTokens, usage.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid_usage');
  const p = priceFor(provider, modelId);
  return roundUsd((usage.inputTokens * p.inputPerMillion + usage.outputTokens * p.outputPerMillion) / 1000000);
}
