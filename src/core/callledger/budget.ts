/** NODE ONLY. Persistent evaluation-run budget; never imported into browser/shared code. */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  exactKeys, ledgerRecord, object, reservationMetadata, settlement, unitsUsd, usdUnits,
} from './ledger.ts';
import type { LedgerRecord, LedgerStatus, ReservationMetadata, SafeRawUsage, Settlement } from './ledger.ts';

export interface BudgetConfig {
  cacheDir?: string;
  live: boolean;
  /** Explicit EVAL_MAX_USD; no default. Cumulative across all dates in this journal. */
  maxUsd: number;
  now?: () => Date;
}
export interface ReservationResult { ledgerId: string; status: LedgerStatus; created: boolean }
export interface CallResult<T> {
  value: T;
  actualUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  rawUsage?: SafeRawUsage;
  latencyMs?: number;
}
export interface BudgetSnapshot {
  capUsd: number;
  committedUsd: number;
  fault: string | null;
  entries: readonly LedgerRecord[];
}
export interface BudgetSession {
  reserve(metadata: ReservationMetadata): Promise<ReservationResult>;
  reconcile(ledgerId: string, value: Settlement): Promise<LedgerRecord>;
  call<T>(metadata: ReservationMetadata, invoke: () => Promise<CallResult<T>>): Promise<{ value: T; ledger: LedgerRecord }>;
  snapshot(): BudgetSnapshot;
}
export class BudgetRefusalError extends Error {
  readonly reservation: ReservationResult;
  constructor(reservation: ReservationResult) {
    super(reservation.created ? reservation.status : 'duplicate_attempt');
    this.name = 'BudgetRefusalError'; this.reservation = { ...reservation };
  }
}
interface Journal { schemaVersion: 1; capUnits: number; committedUnits: number; fault: string | null; entries: LedgerRecord[] }

function charge(row: LedgerRecord): number {
  if (row.status === 'refused_budget' || row.status === 'refused_fault') return 0;
  const reserved = usdUnits(row.reservedUsd);
  return row.costUsd === null ? reserved : Math.min(reserved, usdUnits(row.costUsd));
}
function journal(value: unknown): Journal {
  const raw = object(value);
  exactKeys(raw, ['schemaVersion', 'capUnits', 'committedUnits', 'fault', 'entries']);
  if (raw['schemaVersion'] !== 1 || !Number.isSafeInteger(raw['capUnits']) || (raw['capUnits'] as number) <= 0
    || !Number.isSafeInteger(raw['committedUnits']) || (raw['committedUnits'] as number) < 0
    || !Array.isArray(raw['entries'])) throw new Error('Invalid budget journal');
  usdUnits(unitsUsd(raw['capUnits'] as number));
  // ledgerRecord canonicalizes validated request UUIDs before checking historical attempt keys.
  const entries = raw['entries'].map(ledgerRecord);
  const ids = new Set(entries.map((row) => row.ledgerId));
  const attempts = new Set(entries.map((row) => `${row.requestId}/${row.attempt}`));
  // Reject before recovery writes: never merge, discard or refund colliding historical charges.
  if (attempts.size !== entries.length) throw new Error('Duplicate budget attempt');
  const expected = entries.reduce((sum, row) => sum + charge(row), 0);
  const overruns = entries.filter((row) => row.costUsd !== null && usdUnits(row.costUsd) > usdUnits(row.reservedUsd));
  const fault = raw['fault'];
  if (ids.size !== entries.length || !Number.isSafeInteger(expected)
    || expected !== raw['committedUnits']
    || (overruns.length > 0 ? !overruns.some((row) => fault === `overrun ${row.ledgerId}`) : fault !== null)) throw new Error('Inconsistent budget journal');
  return { schemaVersion: 1, capUnits: raw['capUnits'] as number, committedUnits: expected, fault: fault as string | null, entries };
}
async function atomicWrite(path: string, state: Journal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(state)}\n`, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  // A failed rename is a hard failure; do not run a provider after a failed reserve write.
  await rename(temporary, path);
}
function dateNow(clock: () => Date): string {
  const date = clock();
  if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) throw new Error('Invalid budget clock');
  return date.toISOString();
}

class Session implements BudgetSession {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly calls = new Set<Promise<unknown>>();
  private closed = false;
  private poisoned = false;
  constructor(private readonly state: Journal, private readonly path: string, private readonly clock: () => Date) {}

  private checkOpen(): void {
    if (this.closed) throw new Error('Budget session is closed');
    if (this.poisoned) throw new Error('Budget journal write failed; session is unusable');
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async persist(): Promise<void> {
    try { await atomicWrite(this.path, this.state); }
    catch (error) { this.poisoned = true; throw error; }
  }
  snapshot(): BudgetSnapshot {
    this.checkOpen();
    return { capUsd: unitsUsd(this.state.capUnits), committedUsd: unitsUsd(this.state.committedUnits), fault: this.state.fault,
      entries: this.state.entries.map(ledgerRecord) };
  }
  reserve(metadata: ReservationMetadata): Promise<ReservationResult> {
    this.checkOpen();
    const meta = reservationMetadata(metadata);
    return this.enqueue(() => this.reserveInternal(meta));
  }
  private async reserveInternal(meta: ReservationMetadata): Promise<ReservationResult> {
    if (this.poisoned) throw new Error('Budget journal write failed; session is unusable');
    const existing = this.state.entries.find((row) => row.requestId === meta.requestId && row.attempt === meta.attempt);
    if (existing) return { ledgerId: existing.ledgerId, status: existing.status, created: false };
    const units = usdUnits(meta.estimateUsd);
    const status: LedgerStatus = this.state.fault !== null ? 'refused_fault'
      : units > this.state.capUnits - this.state.committedUnits ? 'refused_budget' : 'reserved';
    const createdAt = dateNow(this.clock);
    const row: LedgerRecord = { ledgerId: randomUUID(), requestId: meta.requestId, attempt: meta.attempt,
      budgetDay: createdAt.slice(0, 10), provider: meta.provider, modelId: meta.modelId, promptHash: meta.promptHash,
      questionIds: [...meta.questionIds], priceTableVersion: meta.priceTableVersion, reservedUsd: meta.estimateUsd,
      costUsd: null, inputTokens: null, outputTokens: null, rawUsage: null, latencyMs: null, status, createdAt, reconciledAt: null };
    this.state.entries.push(row);
    if (status === 'reserved') this.state.committedUnits += units;
    await this.persist();
    return { ledgerId: row.ledgerId, status, created: true };
  }
  reconcile(ledgerId: string, value: Settlement): Promise<LedgerRecord> {
    this.checkOpen();
    const safe = settlement(value);
    return this.enqueue(() => this.reconcileInternal(ledgerId, safe));
  }
  private async reconcileInternal(ledgerId: string, value: Settlement): Promise<LedgerRecord> {
    if (this.poisoned) throw new Error('Budget journal write failed; session is unusable');
    const row = this.state.entries.find((entry) => entry.ledgerId === ledgerId);
    if (!row) throw new Error('Unknown reservation');
    if (row.status !== 'reserved') return ledgerRecord(row);
    const reserved = usdUnits(row.reservedUsd);
    const actual = value.actualUsd === null ? null : usdUnits(value.actualUsd);
    row.status = value.status; row.costUsd = value.actualUsd;
    row.inputTokens = value.inputTokens ?? null; row.outputTokens = value.outputTokens ?? null;
    row.rawUsage = value.rawUsage === undefined ? null : { ...value.rawUsage };
    row.latencyMs = value.latencyMs ?? null; row.reconciledAt = dateNow(this.clock);
    if (actual !== null && actual <= reserved) this.state.committedUnits -= reserved - actual;
    if (actual !== null && actual > reserved) this.state.fault ??= `overrun ${ledgerId}`;
    await this.persist();
    return ledgerRecord(row);
  }
  call<T>(metadata: ReservationMetadata, invoke: () => Promise<CallResult<T>>): Promise<{ value: T; ledger: LedgerRecord }> {
    this.checkOpen();
    const meta = reservationMetadata(metadata);
    const task = this.runCall(meta, invoke);
    this.calls.add(task);
    void task.then(() => this.calls.delete(task), () => this.calls.delete(task));
    return task;
  }
  private async runCall<T>(meta: ReservationMetadata, invoke: () => Promise<CallResult<T>>): Promise<{ value: T; ledger: LedgerRecord }> {
    const reserved = await this.enqueue(() => this.reserveInternal(meta));
    if (!reserved.created || reserved.status !== 'reserved') throw new BudgetRefusalError(reserved);
    let result: CallResult<T>;
    let safe: Settlement;
    try {
      result = await invoke();
      // Explicit projection keeps value/provider replies out of the accounting file.
      safe = settlement({ status: 'ok', actualUsd: result.actualUsd, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, rawUsage: result.rawUsage, latencyMs: result.latencyMs });
    } catch (error) {
      try { await this.enqueue(() => this.reconcileInternal(reserved.ledgerId, { status: 'unknown', actualUsd: null })); }
      catch (settleError) { throw new AggregateError([error, settleError], 'Provider failed and accounting settlement failed'); }
      throw error;
    }
    const ledger = await this.enqueue(() => this.reconcileInternal(reserved.ledgerId, safe));
    return { value: result.value, ledger };
  }
  async finish(): Promise<void> {
    this.closed = true;
    // Do not release the lock while a caller's accidentally unawaited task is paid/in flight.
    await Promise.allSettled([...this.calls]);
    await this.tail;
  }
}

/**
 * One persistent journal is one evaluation-run budget, including across UTC midnight.
 * Use a fresh EXPLICIT cacheDir for a separately authorized run. Changing cap never resets spend.
 * A crashed eval.lock must be verified/recovered manually; never steal or age-delete a lock.
 */
export async function withBudgetSession<T>(config: BudgetConfig, work: (session: BudgetSession) => Promise<T>): Promise<T> {
  if (config.live !== true || typeof config.maxUsd !== 'number' || !Number.isFinite(config.maxUsd) || config.maxUsd <= 0) {
    throw new Error('Live evaluation requires --live and explicit finite positive EVAL_MAX_USD');
  }
  const capUnits = usdUnits(config.maxUsd, 'down');
  if (capUnits <= 0) throw new Error('EVAL_MAX_USD is below accounting precision');
  const cacheDir = resolve(config.cacheDir ?? '.cache');
  const lockPath = join(cacheDir, 'eval.lock');
  const journalPath = join(cacheDir, 'eval-budget.json');
  const clock = config.now ?? (() => new Date());
  const token = `${randomUUID()}\n`;
  await mkdir(cacheDir, { recursive: true });
  // EEXIST refuses immediately. Never unlink a lock that this invocation did not create.
  const lock = await open(lockPath, 'wx', 0o600);
  let session: Session | undefined;
  try {
    await lock.writeFile(token, 'utf8'); await lock.sync();
    let state: Journal;
    try { state = journal(JSON.parse(await readFile(journalPath, 'utf8')) as unknown); }
    catch (error) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      state = { schemaVersion: 1, capUnits, committedUnits: 0, fault: null, entries: [] };
    }
    state.capUnits = capUnits;
    for (const row of state.entries) {
      if (row.status === 'reserved') { row.status = 'unknown'; row.reconciledAt = dateNow(clock); }
    }
    // Recovery is durable before any new callback. Unknown reservations retain their full charge.
    await atomicWrite(journalPath, state);
    session = new Session(state, journalPath, clock);
    return await work(session);
  } finally {
    try { await session?.finish(); }
    finally {
      await lock.close();
      // Cooperative ownership check: a replaced/changed file is never removed by this session.
      if (await readFile(lockPath, 'utf8') !== token) throw new Error('Budget lock ownership changed; lock left untouched');
      await unlink(lockPath);
    }
  }
}
