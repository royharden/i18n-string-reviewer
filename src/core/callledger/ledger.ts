/** Node-only accounting journal. Never import from shared code, reviewers, or browser UI. */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LedgerStatus = 'reserved' | 'ok' | 'provider_error' | 'unknown' | 'refused_budget' | 'refused_fault';
export interface ReservationMetadata {
  requestId: string;
  attempt: number;
  provider: 'anthropic' | 'typesafe' | 'mock';
  modelId: string;
  /** SHA-256 of the entire masked provider request, never an individual string. */
  promptHash: string;
  /** Generated opaque indices q0, q1, ...; never questions or item text. */
  questionIds: readonly string[];
  priceTableVersion: string;
  estimateUsd: number;
}
export interface SafeRawUsage { input_tokens?: number; output_tokens?: number }
export interface Settlement {
  status: 'ok' | 'provider_error' | 'unknown';
  actualUsd: number | null;
  inputTokens?: number;
  outputTokens?: number;
  rawUsage?: SafeRawUsage;
  latencyMs?: number;
}
export interface LedgerRecord {
  ledgerId: string;
  requestId: string;
  attempt: number;
  budgetDay: string;
  provider: ReservationMetadata['provider'];
  modelId: string;
  promptHash: string;
  questionIds: string[];
  priceTableVersion: string;
  reservedUsd: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rawUsage: SafeRawUsage | null;
  latencyMs: number | null;
  status: LedgerStatus;
  createdAt: string;
  reconciledAt: string | null;
}

export const MONEY_SCALE = 100_000_000;
const MAX_UNITS = 99_999_999_999_999; // numeric(14,8), safely below Number.MAX_SAFE_INTEGER
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const STATUSES: readonly string[] = ['reserved', 'ok', 'provider_error', 'unknown', 'refused_budget', 'refused_fault'];

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid accounting object');
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unexpected accounting field');
}
export function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
export function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) throw new Error('Invalid accounting counter');
  return value;
}

/** Convert the decimal representation exactly; binary multiplication can round reserves down. */
export function usdUnits(value: number, rounding: 'up' | 'down' = 'up'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid USD amount');
  const [mantissa = '', exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const coefficient = BigInt(whole + fraction);
  const shift = 8 + Number(exponent) - fraction.length;
  let units: bigint;
  if (shift >= 0) units = coefficient * (10n ** BigInt(shift));
  else {
    const divisor = 10n ** BigInt(-shift);
    units = coefficient / divisor;
    if (rounding === 'up' && coefficient % divisor !== 0n) units += 1n;
  }
  if (units > BigInt(MAX_UNITS)) throw new Error('USD amount exceeds accounting precision');
  return Number(units);
}
export function unitsUsd(units: number): number { return units / MONEY_SCALE; }

export function safeRawUsage(value: unknown): SafeRawUsage {
  const raw = object(value);
  exactKeys(raw, ['input_tokens', 'output_tokens']);
  const safe: SafeRawUsage = {};
  if (Object.hasOwn(raw, 'input_tokens')) safe.input_tokens = counter(raw['input_tokens']);
  if (Object.hasOwn(raw, 'output_tokens')) safe.output_tokens = counter(raw['output_tokens']);
  return safe;
}

export function reservationMetadata(value: ReservationMetadata): ReservationMetadata {
  const raw = object(value);
  exactKeys(raw, ['requestId', 'attempt', 'provider', 'modelId', 'promptHash', 'questionIds', 'priceTableVersion', 'estimateUsd']);
  if (!isUuid(value.requestId) || !Number.isInteger(value.attempt) || value.attempt < 0 || value.attempt > 2_147_483_647
    || !['anthropic', 'typesafe', 'mock'].includes(value.provider)
    || typeof value.modelId !== 'string' || !IDENTIFIER.test(value.modelId)
    || typeof value.priceTableVersion !== 'string' || !IDENTIFIER.test(value.priceTableVersion)
    || typeof value.promptHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.promptHash)
    || !Array.isArray(value.questionIds) || value.questionIds.length > 32
    || value.questionIds.some((id) => typeof id !== 'string' || !/^q[0-9]{1,5}$/u.test(id))
    || typeof value.estimateUsd !== 'number' || value.estimateUsd <= 0) throw new Error('Invalid reservation metadata');
  const estimateUsd = unitsUsd(usdUnits(value.estimateUsd));
  // UUID spelling must not create another dispatch owner, including for recovered records.
  return { requestId: value.requestId.toLowerCase(), attempt: value.attempt, provider: value.provider, modelId: value.modelId,
    promptHash: value.promptHash, questionIds: [...value.questionIds], priceTableVersion: value.priceTableVersion, estimateUsd };
}

export function settlement(value: Settlement): Settlement {
  const raw = object(value);
  exactKeys(raw, ['status', 'actualUsd', 'inputTokens', 'outputTokens', 'rawUsage', 'latencyMs']);
  if (!['ok', 'provider_error', 'unknown'].includes(value.status)
    || (value.status === 'unknown' && value.actualUsd !== null)
    || (value.status === 'ok' && value.actualUsd === null)
    || (value.actualUsd !== null && typeof value.actualUsd !== 'number')) throw new Error('Invalid settlement');
  const result: Settlement = { status: value.status, actualUsd: value.actualUsd === null ? null : unitsUsd(usdUnits(value.actualUsd)) };
  if (value.inputTokens !== undefined) result.inputTokens = counter(value.inputTokens);
  if (value.outputTokens !== undefined) result.outputTokens = counter(value.outputTokens);
  if (value.latencyMs !== undefined) result.latencyMs = counter(value.latencyMs);
  if (value.rawUsage !== undefined) result.rawUsage = safeRawUsage(value.rawUsage);
  return result;
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Reconstruct an allowlisted record before disk writes; never spread provider objects. */
export function ledgerRecord(value: unknown): LedgerRecord {
  const row = object(value);
  exactKeys(row, ['ledgerId', 'requestId', 'attempt', 'budgetDay', 'provider', 'modelId', 'promptHash', 'questionIds',
    'priceTableVersion', 'reservedUsd', 'costUsd', 'inputTokens', 'outputTokens', 'rawUsage', 'latencyMs', 'status', 'createdAt', 'reconciledAt']);
  const meta = reservationMetadata({ requestId: row['requestId'] as string, attempt: row['attempt'] as number,
    provider: row['provider'] as ReservationMetadata['provider'], modelId: row['modelId'] as string,
    promptHash: row['promptHash'] as string, questionIds: row['questionIds'] as string[],
    priceTableVersion: row['priceTableVersion'] as string, estimateUsd: row['reservedUsd'] as number });
  if (!isUuid(row['ledgerId']) || !timestamp(row['createdAt']) || row['budgetDay'] !== row['createdAt'].slice(0, 10)
    || typeof row['status'] !== 'string' || !STATUSES.includes(row['status'])) throw new Error('Invalid ledger record');
  const status = row['status'] as LedgerStatus;
  const final = status === 'ok' || status === 'unknown' || status === 'provider_error';
  if (final ? !timestamp(row['reconciledAt']) : row['reconciledAt'] !== null) throw new Error('Invalid ledger settlement timestamp');
  const costUsd = row['costUsd'] === null ? null : unitsUsd(usdUnits(row['costUsd'] as number));
  if ((!final && costUsd !== null) || (status === 'unknown' && costUsd !== null) || (status === 'ok' && costUsd === null)) throw new Error('Invalid ledger cost');
  return { ledgerId: row['ledgerId'], requestId: meta.requestId, attempt: meta.attempt, budgetDay: row['budgetDay'] as string,
    provider: meta.provider, modelId: meta.modelId, promptHash: meta.promptHash, questionIds: [...meta.questionIds],
    priceTableVersion: meta.priceTableVersion, reservedUsd: meta.estimateUsd, costUsd,
    inputTokens: row['inputTokens'] === null ? null : counter(row['inputTokens']),
    outputTokens: row['outputTokens'] === null ? null : counter(row['outputTokens']),
    rawUsage: row['rawUsage'] === null ? null : safeRawUsage(row['rawUsage']),
    latencyMs: row['latencyMs'] === null ? null : counter(row['latencyMs']), status,
    createdAt: row['createdAt'], reconciledAt: row['reconciledAt'] as string | null };
}

/** M6 may append terminal snapshots while holding its budget session; no provider text accepted. */
export async function appendLedgerRecord(path: string, value: LedgerRecord): Promise<void> {
  const row = ledgerRecord(value);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}
