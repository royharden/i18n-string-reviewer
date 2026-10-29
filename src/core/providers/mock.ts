import type { Provider, ProviderRequest, ProviderResult } from './types.ts';
/** Inject recorded provider values; no network, environment or filesystem access. */
export function createMockProvider(reply: (request: ProviderRequest) => unknown): Provider {
  return { complete(request): Promise<ProviderResult> { return Promise.resolve({ value: reply(request), usage: { inputTokens: 0, outputTokens: 0 }, rawUsage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, retries: 0 }); } };
}
