// Browser: injected edge invocation. Node: injected, durably budgeted provider transport.
// No keys, environment reads or direct provider imports can enter the browser through this module.
import { parseReviewResponse } from '../shared/wire.ts';
import type { ReviewRequest, ReviewResponse } from '../shared/wire.ts';
import type { MaskedItem, Reviewer } from './types.ts';
export interface ReviewTransportOptions { readonly estimateHash?: string }
export type ReviewTransport = (request: ReviewRequest, options?: ReviewTransportOptions) => Promise<ReviewResponse>;
export interface LlmReviewerOptions {
  readonly transport: ReviewTransport;
  readonly requestForBatch?: (batch: readonly MaskedItem[], withContext: boolean) => { readonly requestId: string; readonly attempt: number };
  readonly onResponse?: (response: ReviewResponse) => void;
}
export function createLlmReviewer(options: LlmReviewerOptions): Reviewer {
  return {
    id: 'llm', label: 'LLM (live, metered)',
    async review(batch, opts = {}) {
      const withContext = opts.withContext ?? true;
      const identity = options.requestForBatch?.(batch, withContext) ?? { requestId: crypto.randomUUID(), attempt: 1 };
      const request: ReviewRequest = { ...identity, schemaVersion: 1, reviewer: 'llm', withContext, items: batch };
      const response = parseReviewResponse(await options.transport(request));
      if (response.reviewer !== 'llm') throw new Error('invalid_review_response');
      options.onResponse?.(response);
      return { rawFindings: response.rawFindings, usage: response.usage };
    },
  };
}
