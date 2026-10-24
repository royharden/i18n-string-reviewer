// Deployable wire contract. No runtime dependency outside shared/ (also copied to Deno).
import { redactText } from './redact.ts';

export const SCHEMA_VERSION = 1;
export const MAX_ITEMS = 20;
export const MAX_REQUEST_BYTES = 200 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export type LiveReviewer = 'llm' | 'jev';
export type ProviderId = 'anthropic' | 'typesafe';
export interface WireLegendEntry {
  readonly field: 'key' | 'source' | 'target' | 'screen' | 'note' | 'description' | 'glossary' | 'sibling';
  readonly token: string;
  readonly kind: 'placeholder' | 'tag' | 'skeleton';
  readonly display: string;
}
export interface WireMaskedItem {
  readonly itemId: string;
  readonly key: readonly string[];
  readonly locale: string;
  readonly sourceLocale: string;
  readonly dialect: 'plain' | 'icu' | 'i18next';
  readonly source: string;
  readonly target: string;
  readonly context: string;
  readonly legend: readonly WireLegendEntry[];
  readonly fixAllowed: boolean;
}
export interface ReviewRequest {
  readonly requestId: string;
  readonly attempt: number;
  readonly schemaVersion: 1;
  readonly reviewer: LiveReviewer;
  readonly withContext: boolean;
  readonly items: readonly WireMaskedItem[];
}
export interface Usage { readonly inputTokens: number; readonly outputTokens: number }
export interface SafeRawUsage { readonly input_tokens: number; readonly output_tokens: number }
export type ReviewResponse =
  | { readonly reviewer: 'llm'; readonly rawFindings: unknown; readonly usage: Usage; readonly ledgerId: string }
  | { readonly reviewer: 'jev'; readonly probabilities: Readonly<Record<string, number>>; readonly usage: Usage; readonly ledgerId: string };
export interface PreviewResponse {
  readonly estimateUsd: number;
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly priceTableVersion: string;
  readonly requestHash: string;
  readonly stringCount: number;
}
export class WireError extends Error {
  constructor() { super('invalid_request'); this.name = 'WireError'; }
}
function fail(): never { throw new WireError(); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(o, k))) return fail();
  return o;
}
function text(v: unknown, max: number, min = 0): string {
  if (typeof v !== 'string' || v.length < min || v.length > max) return fail();
  return v;
}
function bool(v: unknown): boolean { return typeof v === 'boolean' ? v : fail(); }
export function tokenCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 2147483647) return fail();
  return v;
}
function locale(v: unknown): string {
  const s = text(v, 64, 1);
  try {
    if (Intl.getCanonicalLocales(s).length !== 1 || Intl.PluralRules.supportedLocalesOf([s]).length !== 1) return fail();
  } catch { return fail(); }
  return s;
}
function legend(value: unknown): WireLegendEntry {
  const o = object(value, ['field', 'token', 'kind', 'display']);
  if (typeof o['field'] !== 'string' || !['key', 'source', 'target', 'screen', 'note', 'description', 'glossary', 'sibling'].includes(o['field'])) return fail();
  if (typeof o['kind'] !== 'string' || !['placeholder', 'tag', 'skeleton'].includes(o['kind'])) return fail();
  return { field: o['field'] as WireLegendEntry['field'], token: text(o['token'], 64, 1), kind: o['kind'] as WireLegendEntry['kind'], display: text(o['display'], 4000) };
}
function item(value: unknown): WireMaskedItem {
  const o = object(value, ['itemId', 'key', 'locale', 'sourceLocale', 'dialect', 'source', 'target', 'context', 'legend', 'fixAllowed']);
  const keys = o['key']; const legends = o['legend'];
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 64 || !Array.isArray(legends) || legends.length > 512) return fail();
  if (typeof o['dialect'] !== 'string' || !['plain', 'icu', 'i18next'].includes(o['dialect'])) return fail();
  return { itemId: text(o['itemId'], 200, 1), key: keys.map((k) => text(k, 2000)), locale: locale(o['locale']), sourceLocale: locale(o['sourceLocale']), dialect: o['dialect'] as WireMaskedItem['dialect'], source: text(o['source'], 100000), target: text(o['target'], 100000), context: text(o['context'], 2000), legend: legends.map(legend), fixAllowed: bool(o['fixAllowed']) };
}
export function parseReviewRequest(value: unknown): ReviewRequest {
  const o = object(value, ['requestId', 'attempt', 'schemaVersion', 'reviewer', 'withContext', 'items']);
  const id = text(o['requestId'], 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) || o['schemaVersion'] !== 1 || (o['reviewer'] !== 'llm' && o['reviewer'] !== 'jev')) return fail();
  const list = o['items'];
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) return fail();
  const items = list.map(item);
  if (new Set(items.map((i) => i.itemId)).size !== items.length) return fail();
  return { requestId: id, attempt: tokenCount(o['attempt']), schemaVersion: 1, reviewer: o['reviewer'], withContext: bool(o['withContext']), items };
}
/** All model-visible strings are re-redacted, including identifiers, key segments and legends. */
export function redactItems(items: readonly WireMaskedItem[]): readonly WireMaskedItem[] {
  return items.map((i) => {
    let changed = false;
    const r = (s: string): string => { const result = redactText(s); changed ||= result.count > 0; return result.text; };
    const fields = { itemId: r(i.itemId), key: i.key.map(r), locale: r(i.locale), sourceLocale: r(i.sourceLocale), dialect: i.dialect, source: r(i.source), target: r(i.target), context: r(i.context), legend: i.legend.map((l) => ({ field: l.field, token: r(l.token), kind: l.kind, display: r(l.display) })) };
    const secretToken = [fields.source, fields.target, fields.context, ...fields.key].some((s) => /⟦R\d+⟧/u.test(s));
    return { ...fields, fixAllowed: i.fixAllowed && !changed && !secretToken };
  });
}
export function parseUsage(value: unknown): Usage {
  const o = object(value, ['inputTokens', 'outputTokens']);
  return { inputTokens: tokenCount(o['inputTokens']), outputTokens: tokenCount(o['outputTokens']) };
}
export function parseReviewResponse(value: unknown): ReviewResponse {
  if (value === null || typeof value !== 'object') return fail();
  const reviewer = (value as Record<string, unknown>)['reviewer'];
  const o = object(value, ['reviewer', reviewer === 'llm' ? 'rawFindings' : 'probabilities', 'usage', 'ledgerId']);
  const usage = parseUsage(o['usage']); const ledgerId = text(o['ledgerId'], 200, 1);
  if (reviewer === 'llm') return { reviewer, rawFindings: o['rawFindings'], usage, ledgerId };
  if (reviewer !== 'jev') return fail();
  const p = o['probabilities'];
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return fail();
  const probabilities: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [k, v] of Object.entries(p)) {
    if (!/^q\d+$/u.test(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return fail();
    probabilities[k] = v;
  }
  return { reviewer, probabilities, usage, ledgerId };
}
export function parsePreviewResponse(value: unknown): PreviewResponse {
  const o = object(value, ['estimateUsd', 'modelId', 'provider', 'priceTableVersion', 'requestHash', 'stringCount']);
  const cost = o['estimateUsd'];
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || (o['provider'] !== 'anthropic' && o['provider'] !== 'typesafe')) return fail();
  const hash = text(o['requestHash'], 64, 64);
  if (!/^[0-9a-f]{64}$/u.test(hash)) return fail();
  const count = tokenCount(o['stringCount']); if (count < 1 || count > MAX_ITEMS) return fail();
  return { estimateUsd: cost, modelId: text(o['modelId'], 200, 1), provider: o['provider'], priceTableVersion: text(o['priceTableVersion'], 100, 1), requestHash: hash, stringCount: count };
}
