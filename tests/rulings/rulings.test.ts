import { expect, it } from 'vitest';
import { itemFingerprint, suggestionHash, stringKey } from '../../src/core/rulings/fingerprint.ts';
import { exportableApprovals, makeRuling, parseRulingsJsonl, pickCompetingApproval, replayRulings, serializeRulings } from '../../src/core/rulings/rulings.ts';
const id = 'a'.repeat(64); const otherId = 'b'.repeat(64);
const at = '2026-10-24T12:00:00Z';
async function state() {
  const fingerprint = await itemFingerprint({ key: ['post'], locale: 'fr', source: 'Post', target: 'Publier', ruleOrCategory: 'context_mismatch' });
  const finding = { id, key: ['post'], locale: 'fr', suggestionHash: await suggestionHash('Publication') };
  return { finding, fingerprint };
}
it('replays the latest append-only decision and reports timestamp conflicts', async () => {
  const c = await state();
  const first = makeRuling({ ...c, decision: 'reject', at });
  const second = makeRuling({ ...c, decision: 'skip', at });
  const replay = replayRulings([first, second], [c]);
  expect(replay.byFinding.get(id)?.ruling.decision).toBe('skip'); expect(replay.conflicts).toHaveLength(1);
});
it('invalidates changed text and changed suggestions', async () => {
  const c = await state(); const approval = makeRuling({ ...c, decision: 'approve_fix', at });
  expect(replayRulings([approval], [{ ...c, fingerprint: 'c'.repeat(64) }]).byFinding.get(id)?.status).toBe('invalidated_text');
  expect(replayRulings([approval], [{ ...c, finding: { ...c.finding, suggestionHash: await suggestionHash('Billet') } }]).byFinding.get(id)?.status).toBe('invalidated_suggestion');
  const disappeared = replayRulings([approval], [], new Set([stringKey(['post'], 'fr')]));
  expect(disappeared.invalidatedStrings.size).toBe(1); expect(exportableApprovals(disappeared)).toEqual([]);
});
it('requires suggestion hash on approval and rejects bad JSONL lines with their numbers', async () => {
  const c = await state(); const valid = makeRuling({ ...c, decision: 'approve_fix', at });
  const parsed = parseRulingsJsonl(serializeRulings([valid]) + 'not json\n' + JSON.stringify({ ...valid, suggestionHash: undefined }) + '\n');
  expect(parsed.rulings).toHaveLength(1); expect(parsed.errors.map((e) => e.line)).toEqual([2, 3]);
  expect(() => makeRuling({ finding: { id, key: ['post'], locale: 'fr' }, fingerprint: c.fingerprint, decision: 'approve_fix', at })).toThrow();
});
it('holds competing approvals until an explicit pick appends rejections', async () => {
  const a = await state(); const b = { ...a, finding: { ...a.finding, id: otherId, suggestionHash: await suggestionHash('Billet') } };
  const rulings = [makeRuling({ ...a, decision: 'approve_fix', at }), makeRuling({ ...b, decision: 'approve_fix', at })];
  const replay = replayRulings(rulings, [a, b]); const sk = stringKey(['post'], 'fr');
  expect(replay.competing.has(sk)).toBe(true); expect(exportableApprovals(replay)).toEqual([]);
  const picked = replayRulings([...rulings, ...pickCompetingApproval(replay, sk, id, '2026-10-24T12:01:00Z')], [a, b]);
  expect(exportableApprovals(picked).map((s) => s.ruling.findingId)).toEqual([id]);
});
