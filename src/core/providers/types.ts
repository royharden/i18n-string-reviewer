import type { ProviderRequest } from '../shared/prompt.ts';
import type { CompleteOptions, ProviderResult } from '../shared/transport.ts';
export type { ProviderRequest } from '../shared/prompt.ts';
export type { CompleteOptions, ProviderResult } from '../shared/transport.ts';
export interface Provider { complete(request: ProviderRequest, options?: CompleteOptions): Promise<ProviderResult> }
