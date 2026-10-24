// Test sources only during Dirty Mode. Run later: npx vitest run tests/callledger/budget.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { BudgetRefusalError, withBudgetSession } from '../../src/core/callledger/budget.ts';
import { appendLedgerRecord, usdUnits } from '../../src/core/callledger/ledger.ts';
import type { BudgetSession } from '../../src/core/callledger/budget.ts';
import type { LedgerRecord, ReservationMetadata } from '../../src/core/callledger/ledger.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 's34-budget-')); directories.push(path); return path;
}
function meta(estimateUsd = 0.4, requestId = randomUUID(), attempt = 0): ReservationMetadata {
  return { requestId, attempt, provider: 'mock', modelId: 'mock-v1', promptHash: 'a'.repeat(64),
    questionIds: ['q0'], priceTableVersion: 'test-20261024', estimateUsd };
}
async function persisted(cacheDir: string): Promise<{ entries: LedgerRecord[]; committedUnits: number }> {
  return JSON.parse(await readFile(join(cacheDir, 'eval-budget.json'), 'utf8')) as { entries: LedgerRecord[]; committedUnits: number };
}

it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses missing/nonpositive/nonfinite cap %s before callback', async (cap) => {
  const callback = vi.fn();
  await expect(withBudgetSession({ cacheDir: await directory(), live: true, maxUsd: cap as number }, callback)).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
});
it('requires explicit --live and never invokes the session callback', async () => {
  const callback = vi.fn();
  await expect(withBudgetSession({ cacheDir: await directory(), live: false, maxUsd: 1 }, callback)).rejects.toThrow('--live');
  expect(callback).not.toHaveBeenCalled();
});
it('holds wx lock through the call, refuses a second session and leaves its owner intact', async () => {
  const cacheDir = await directory();
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async () => {
    const before = await readFile(join(cacheDir, 'eval.lock'), 'utf8');
    await expect(withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async () => undefined)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(cacheDir, 'eval.lock'), 'utf8')).toBe(before);
  });
  await expect(readFile(join(cacheDir, 'eval.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not age-delete or steal a crashed lock', async () => {
  const cacheDir = await directory();
  await writeFile(join(cacheDir, 'eval.lock'), 'operator-must-verify-this-lock\n');
  await expect(withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async () => undefined)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(cacheDir, 'eval.lock'), 'utf8')).toBe('operator-must-verify-this-lock\n');
});
it('persists reserved before provider dispatch and keeps callback product text out of both journals', async () => {
  const cacheDir = await directory();
  const text = 'SYNTHETIC PRODUCT REPLY NOT ACCOUNTING';
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    const result = await session.call(meta(), async () => {
      expect((await persisted(cacheDir)).entries[0]?.status).toBe('reserved');
      return { value: text, actualUsd: 0.1, inputTokens: 4, outputTokens: 2, rawUsage: { input_tokens: 4, output_tokens: 2 }, latencyMs: 10 };
    });
    expect(result.value).toBe(text); expect(result.ledger.status).toBe('ok');
    expect(session.snapshot().committedUsd).toBe(0.1);
    await appendLedgerRecord(join(cacheDir, 'ledger.jsonl'), result.ledger);
  });
  expect(await readFile(join(cacheDir, 'eval-budget.json'), 'utf8')).not.toContain(text);
  expect(await readFile(join(cacheDir, 'ledger.jsonl'), 'utf8')).not.toContain(text);
});
it('never dispatches after an atomic journal replacement failure, and poisons that session', async () => {
  const cacheDir = await directory(); const callback = vi.fn(async () => ({ value: 1, actualUsd: 0 }));
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    // Deliberately sabotage only this test's temporary destination: rename over a directory fails
    // on both Windows and POSIX, without relying on platform-specific permission semantics.
    await rm(join(cacheDir, 'eval-budget.json'));
    await mkdir(join(cacheDir, 'eval-budget.json'));
    await expect(session.call(meta(), callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(() => session.snapshot()).toThrow('unusable');
  });
});
it('unknown provider failure retains the full reservation, without persisting the error text', async () => {
  const cacheDir = await directory(); const failure = new Error('SYNTHETIC PRIVATE PROVIDER ERROR');
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    await expect(session.call(meta(), async () => { throw failure; })).rejects.toBe(failure);
    expect(session.snapshot().committedUsd).toBe(0.4);
    expect(session.snapshot().entries[0]?.status).toBe('unknown');
  });
  expect(await readFile(join(cacheDir, 'eval-budget.json'), 'utf8')).not.toContain(failure.message);
});
it('recovers stale reservations as unknown before resumed work, and does not refund them', async () => {
  const cacheDir = await directory();
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => { await session.reserve(meta(0.8)); });
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    expect((await persisted(cacheDir)).entries[0]?.status).toBe('unknown');
    expect(session.snapshot().committedUsd).toBe(0.8);
    const row = session.snapshot().entries[0]; if (!row) throw new Error('missing fixture');
    await session.reconcile(row.ledgerId, { status: 'ok', actualUsd: 0 });
    expect(session.snapshot().committedUsd).toBe(0.8);
    expect((await session.reserve(meta(0.3))).status).toBe('refused_budget');
  });
});
it('serializes parallel reservations, and invokes a duplicate attempt callback only once', async () => {
  const cacheDir = await directory(); const request = meta(0.2); const callback = vi.fn(async () => ({ value: 1, actualUsd: 0.2 }));
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    const attempts = await Promise.allSettled([session.call(request, callback), session.call(request, callback)]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(callback).toHaveBeenCalledTimes(1);
    const rows = await Promise.all(Array.from({ length: 12 }, () => session.reserve(meta(0.2))));
    expect(rows.filter((row) => row.status === 'reserved')).toHaveLength(4);
    expect(session.snapshot().committedUsd).toBe(1);
  });
});
it('returns created=false while the original provider is in flight, without reconciling it', async () => {
  const cacheDir = await directory(); const request = meta();
  let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const dispatch = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    const original = session.call(request, async () => { entered?.(); await pending; return { value: 1, actualUsd: 0.1 }; });
    await dispatch;
    const duplicate = await session.reserve(request);
    expect(duplicate.created).toBe(false); expect(duplicate.status).toBe('reserved');
    const forbidden = vi.fn(async () => ({ value: 0, actualUsd: 0 }));
    await expect(session.call(request, forbidden)).rejects.toBeInstanceOf(BudgetRefusalError);
    expect(forbidden).not.toHaveBeenCalled(); expect(session.snapshot().entries[0]?.status).toBe('reserved');
    release?.(); await original;
  });
});
it('dispatches case aliases of one UUID attempt only once in flight and after resume', async () => {
  const cacheDir = await directory();
  const requestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const request = meta(0.4, requestId.toUpperCase());
  let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const dispatch = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const callback = vi.fn(async () => { entered?.(); await pending; return { value: 1, actualUsd: 0.1 }; });
  const forbidden = vi.fn(async () => ({ value: 0, actualUsd: 0 }));
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    const original = session.call(request, callback);
    try {
      await dispatch;
      await expect(session.call({ ...request, requestId }, forbidden)).rejects.toMatchObject({
        reservation: { created: false, status: 'reserved' },
      });
      expect(await session.reserve({ ...request, requestId })).toMatchObject({ created: false, status: 'reserved' });
      expect(callback).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
      expect(session.snapshot().entries).toHaveLength(1);
      expect(session.snapshot().committedUsd).toBe(0.4);
      expect((await persisted(cacheDir)).entries[0]?.requestId).toBe(requestId);
    } finally { release?.(); await original; }
    expect(session.snapshot().committedUsd).toBe(0.1);
  });
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    expect(await session.reserve(request)).toMatchObject({ created: false, status: 'ok' });
    await expect(session.call({ ...request, requestId }, forbidden)).rejects.toBeInstanceOf(BudgetRefusalError);
    expect(session.snapshot().entries).toHaveLength(1);
    expect(session.snapshot().committedUsd).toBe(0.1);
  });
  expect(callback).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
  expect((await persisted(cacheDir)).committedUnits).toBe(usdUnits(0.1));
});
it('canonicalizes uppercase historical request UUIDs before resumed work without refunding stale charges', async () => {
  const cacheDir = await directory();
  const requestId = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
  const request = meta(0.4, requestId);
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => { await session.reserve(request); });
  const historical = await persisted(cacheDir);
  const row = historical.entries[0]; if (!row) throw new Error('missing fixture');
  row.requestId = requestId.toUpperCase();
  await writeFile(join(cacheDir, 'eval-budget.json'), JSON.stringify(historical));
  const forbidden = vi.fn(async () => ({ value: 0, actualUsd: 0 }));
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    const recovered = await persisted(cacheDir);
    expect(recovered.entries).toHaveLength(1);
    expect(recovered.entries[0]).toMatchObject({ requestId, status: 'unknown' });
    expect(recovered.committedUnits).toBe(historical.committedUnits);
    expect(await session.reserve(request)).toMatchObject({ ledgerId: row.ledgerId, created: false, status: 'unknown' });
    await expect(session.call({ ...request, requestId: requestId.toUpperCase() }, forbidden)).rejects.toBeInstanceOf(BudgetRefusalError);
    expect(session.snapshot().committedUsd).toBe(0.4);
    expect(session.snapshot().entries).toHaveLength(1);
  });
  expect(forbidden).not.toHaveBeenCalled();
  expect((await persisted(cacheDir)).committedUnits).toBe(usdUnits(0.4));
});
it('rejects canonical duplicate historical attempts without rewriting their rows or charges', async () => {
  const cacheDir = await directory();
  const requestId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    await session.reserve(meta(0.4, requestId));
    await session.reserve(meta(0.4, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
  });
  const historical = await persisted(cacheDir);
  const second = historical.entries[1]; if (!second) throw new Error('missing fixture');
  second.requestId = requestId.toUpperCase();
  const contents = `${JSON.stringify(historical, null, 2)}\n`;
  await writeFile(join(cacheDir, 'eval-budget.json'), contents);
  const forbidden = vi.fn(async () => undefined);
  await expect(withBudgetSession({ cacheDir, live: true, maxUsd: 2 }, forbidden)).rejects.toThrow('Duplicate budget attempt');
  expect(forbidden).not.toHaveBeenCalled();
  expect(await readFile(join(cacheDir, 'eval-budget.json'), 'utf8')).toBe(contents);
  expect(historical.entries).toHaveLength(2);
  expect(historical.committedUnits).toBe(usdUnits(0.8));
});
it('settles once, retains refusals unchanged, and faults persistently on overrun', async () => {
  const cacheDir = await directory();
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    const a = await session.reserve(meta(0.5));
    await session.reconcile(a.ledgerId, { status: 'ok', actualUsd: 0.2 });
    await session.reconcile(a.ledgerId, { status: 'ok', actualUsd: 0 });
    expect(session.snapshot().committedUsd).toBe(0.2);
    const b = await session.reserve(meta(0.3));
    await session.reconcile(b.ledgerId, { status: 'ok', actualUsd: 0.4 });
    expect(session.snapshot().committedUsd).toBe(0.5); expect(session.snapshot().fault).toBe(`overrun ${b.ledgerId}`);
    const refused = await session.reserve(meta(0.1));
    expect(refused.status).toBe('refused_fault');
    expect((await session.reconcile(refused.ledgerId, { status: 'ok', actualUsd: 0 })).status).toBe('refused_fault');
  });
  await withBudgetSession({ cacheDir, live: true, maxUsd: 2 }, async (session) => {
    expect((await session.reserve(meta(0.1))).status).toBe('refused_fault');
  });
});
it('does not reset Node run spend across midnight or cap changes', async () => {
  const cacheDir = await directory(); let time = new Date('2026-10-24T23:59:59.000Z');
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1, now: () => time }, async (session) => {
    const reserved = await session.reserve(meta(0.8));
    time = new Date('2026-10-25T00:00:01.000Z');
    await session.reconcile(reserved.ledgerId, { status: 'ok', actualUsd: 0.7 });
    expect(session.snapshot().entries[0]?.budgetDay).toBe('2026-10-24');
    expect((await session.reserve(meta(0.4))).status).toBe('refused_budget');
  });
  await withBudgetSession({ cacheDir, live: true, maxUsd: 0.5, now: () => time }, async (session) => {
    expect(session.snapshot().committedUsd).toBe(0.7);
    expect((await session.reserve(meta(0.1))).status).toBe('refused_budget');
  });
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1.1, now: () => time }, async (session) => {
    expect(session.snapshot().committedUsd).toBe(0.7);
    expect((await session.reserve(meta(0.4))).status).toBe('reserved');
  });
});
it('rejects corrupt journals rather than resetting spend, and permits a deliberate fresh run directory', async () => {
  const cacheDir = await directory();
  await writeFile(join(cacheDir, 'eval-budget.json'), '{invalid');
  const callback = vi.fn();
  await expect(withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, callback)).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
  await withBudgetSession({ cacheDir: await directory(), live: true, maxUsd: 1 }, async (session) => {
    expect(session.snapshot().committedUsd).toBe(0);
  });
});
it('rejects unsafe usage metadata after dispatch as unknown, charging in full', async () => {
  const cacheDir = await directory();
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    await expect(session.call(meta(), async () => ({ value: 'answer', actualUsd: 0,
      rawUsage: { input_tokens: 1, model_reply: 'PRIVATE' } as { input_tokens: number } }))).rejects.toThrow('Unexpected accounting field');
    expect(session.snapshot().entries[0]?.status).toBe('unknown'); expect(session.snapshot().committedUsd).toBe(0.4);
  });
  expect(await readFile(join(cacheDir, 'eval-budget.json'), 'utf8')).not.toContain('PRIVATE');
});
it('rounds decimal reserves up and caps down without binary-multiplication drift', () => {
  expect(usdUnits(0.07)).toBe(7_000_000);
  expect(usdUnits(0.000000001)).toBe(1);
  expect(usdUnits(0.123456789)).toBe(12_345_679);
  expect(usdUnits(0.123456789, 'down')).toBe(12_345_678);
});
it('releases its lock after a work error and rejects retained session use', async () => {
  const cacheDir = await directory(); let retained: BudgetSession | undefined;
  await expect(withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async (session) => {
    retained = session; throw new Error('work failed');
  })).rejects.toThrow('work failed');
  expect(() => retained?.snapshot()).toThrow('closed');
  await withBudgetSession({ cacheDir, live: true, maxUsd: 1 }, async () => undefined);
});
