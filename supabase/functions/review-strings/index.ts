import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { createHandler } from './handler.ts';
import type { BudgetPort, LedgerStatus } from './handler.ts';
import { createFetchTransport } from './_shared/transport.ts';

const env = (name: string): string => Deno.env.get(name) ?? '';
const url = env('SUPABASE_URL'); const anonKey = env('SUPABASE_ANON_KEY');
const list = (name: string): string[] => env(name).split(',').map((v) => v.trim()).filter(Boolean);
// Public auth client only. The service-role client is constructed lazily inside a budget operation.
const authClient = url && anonKey ? createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
let adminClient: ReturnType<typeof createClient> | null = null;
function admin(): ReturnType<typeof createClient> {
  if (!adminClient) {
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('accounting_unavailable');
    adminClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return adminClient;
}
const statuses: readonly LedgerStatus[] = ['reserved', 'ok', 'provider_error', 'unknown', 'refused_budget', 'refused_fault'];
const budget: BudgetPort = {
  async reserve(m) {
    const { data, error } = await admin().rpc('reserve_budget', { p_request_id: m.requestId, p_attempt: m.attempt, p_user: m.userId, p_provider: m.provider, p_model: m.modelId, p_prompt_hash: m.promptHash, p_question_ids: [...m.questionIds], p_estimate: m.estimateUsd, p_cap: m.capUsd, p_price_version: m.priceTableVersion });
    const row: unknown = Array.isArray(data) ? data[0] : undefined;
    if (error || !row || typeof row !== 'object') throw new Error('accounting_unavailable');
    const r = row as Record<string, unknown>;
    if (typeof r['ledger_id'] !== 'string' || typeof r['created'] !== 'boolean' || !statuses.includes(r['status'] as LedgerStatus)) throw new Error('accounting_unavailable');
    return { ledgerId: r['ledger_id'], status: r['status'] as LedgerStatus, created: r['created'] };
  },
  async reconcile(s) {
    const { data, error } = await admin().rpc('reconcile_budget', { p_ledger_id: s.ledgerId, p_status: s.status, p_actual: s.actualUsd, p_input: s.inputTokens, p_output: s.outputTokens, p_raw: s.rawUsage, p_latency: s.latencyMs });
    if (error) throw new Error('accounting_unavailable');
    return data;
  },
};
const anthropicApiKey = env('ANTHROPIC_API_KEY'); const typesafeApiKey = env('TYPESAFE_API_KEY');
const cap = env('DAILY_BUDGET_USD');
Deno.serve(createHandler({
  auth: { async getUser(jwt) { if (!authClient) return { data: { user: null }, error: 'auth_not_configured' }; return authClient.auth.getUser(jwt); } },
  budget,
  complete: createFetchTransport({ fetch: globalThis.fetch.bind(globalThis), anthropicApiKey, typesafeApiKey }),
  config: { allowedEmails: list('ALLOWED_EMAILS'), allowedOrigins: list('ALLOWED_ORIGINS'), anonKey, ...(env('ANTHROPIC_MODEL_ID') ? { anthropicModelId: env('ANTHROPIC_MODEL_ID') } : {}), dailyBudgetUsd: cap.trim() === '' ? Number.NaN : Number(cap), providerConfigured: (provider) => Boolean(provider === 'anthropic' ? anthropicApiKey : typesafeApiKey) },
}));
