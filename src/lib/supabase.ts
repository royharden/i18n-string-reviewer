import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parsePreviewResponse, parseReviewResponse } from '../core/shared/wire.ts';
import type { PreviewResponse, ReviewRequest, ReviewResponse } from '../core/shared/wire.ts';
import { configuredSupabaseOrigin } from './publicConfig.ts';

let client: SupabaseClient | null | undefined;

/** Only the two public browser settings are read. Missing configuration leaves local mode usable. */
export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = String(import.meta.env.VITE_SUPABASE_URL ?? '').trim();
  const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  if (!url && !anonKey) { client = null; return null; }
  if (!url || !anonKey) throw new Error('Live review requires both public Supabase URL and anon key settings.');
  const origin = configuredSupabaseOrigin(url);
  client = createClient(origin, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  return client;
}

export class LiveReviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'LiveReviewError'; }
}

const messages: Readonly<Record<string, string>> = {
  stale_preview: 'The request, model or pricing changed. Obtain a new preview and confirm again.',
  budget: 'The daily budget cannot cover this batch.', fault: 'Live review is blocked by a server accounting fault.',
  provider_not_configured: 'The provider is not configured on the server.',
};

async function invoke(client: SupabaseClient, request: ReviewRequest, headers: Record<string, string>, expectedUserId?: string): Promise<unknown> {
  const session = await client.auth.getSession();
  if (session.error || !session.data.session?.access_token) throw new LiveReviewError(401, 'authentication', 'Sign in again before sending a live request.');
  if (expectedUserId && session.data.session.user.id !== expectedUserId) throw new LiveReviewError(401, 'authentication_changed', 'The signed-in user changed. Obtain a new preview.');
  const response = await client.functions.invoke<unknown>('review-strings', { body: request, headers: { ...headers, Authorization: `Bearer ${session.data.session.access_token}` } });
  if (response.error) {
    const context = (response.error as { context?: unknown }).context;
    const status = context instanceof Response ? context.status : 0;
    let code = '';
    if (context instanceof Response) {
      try {
        const value: unknown = await context.clone().json();
        if (value && typeof value === 'object') {
          const record = value as Record<string, unknown>;
          const candidate = record.reason ?? record.error;
          if (typeof candidate === 'string' && /^[a-z_]{1,60}$/u.test(candidate)) code = candidate;
        }
      } catch { /* Responses without JSON still produce an explicit status-based error. */ }
    }
    const fallback: Readonly<Record<number, string>> = { 400: 'The live request was rejected as invalid.', 401: 'Your sign-in expired or is invalid. Sign in again.', 403: 'Live review requires a confirmed email on the server allowlist.', 409: 'This attempt already exists or its preview changed. Preview a new run.', 413: 'This masked batch exceeds the server request size limit.', 429: 'The server budget or accounting fault blocked this batch.', 503: 'Live review is not configured on the server.', 504: 'The provider timed out. Its reserved cost may remain charged.' };
    throw new LiveReviewError(status, code, messages[code] ?? fallback[status] ?? 'The live service could not complete this request. No mock fallback was used.');
  }
  return response.data;
}

export async function previewLiveReview(client: SupabaseClient, request: ReviewRequest, expectedUserId?: string): Promise<PreviewResponse> {
  const data = await invoke(client, request, { 'x-review-mode': 'preview' }, expectedUserId);
  try { return parsePreviewResponse(data); }
  catch { throw new LiveReviewError(502, 'invalid_response', 'The server returned an invalid preview. No provider run was started.'); }
}

export async function executeLiveReview(client: SupabaseClient, request: ReviewRequest, estimateHash: string, expectedUserId?: string): Promise<ReviewResponse> {
  const data = await invoke(client, request, { 'x-review-estimate-hash': estimateHash }, expectedUserId);
  try { return parseReviewResponse(data); }
  catch { throw new LiveReviewError(502, 'invalid_response', 'The server returned an invalid live response. The attempt may still have incurred cost.'); }
}
