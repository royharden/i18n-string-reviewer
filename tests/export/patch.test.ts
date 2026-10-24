import { expect, it } from 'vitest';
import type { Finding } from '../../src/core/cited/finding.ts';
import { applyApprovedFixes } from '../../src/core/export/patch.ts';
import { parseLocale } from '../../src/core/l10nchecks/parse.ts';
import { pathKey } from '../../src/core/l10nchecks/paths.ts';
import { maskTarget } from '../../src/core/maskgate/mask.ts';
import { findingIdFor, suggestionHash } from '../../src/core/rulings/fingerprint.ts';
import { fingerprintForFinding, makeRuling } from '../../src/core/rulings/rulings.ts';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
async function setup(target = '{\r\n  "post": "Publier",\r\n  "untouched": "é"\r\n}\r\n') {
  const source = parseLocale(bytes('{"post":"Post","untouched":"Unchanged"}'), { fileName: 'en.json', locale: 'en', dialect: 'plain', role: 'source' }).doc;
  const doc = parseLocale(bytes(target), { fileName: 'fr.json', locale: 'fr', dialect: 'plain', role: 'target' }).doc;
  const masked = maskTarget('Publication', 'plain').masked;
  const finding: Finding = { id: await findingIdFor({ key: ['post'], locale: 'fr', source: 'Post', target: 'Publier', ruleOrCategory: 'context_mismatch' }), key: ['post'], locale: 'fr', category: 'context_mismatch', severity: 'major', explanation: 'Noun', evidence: 'Publier', evidenceStatus: 'supported', suggestedFix: 'Publication', suggestedFixMasked: masked, suggestionHash: await suggestionHash('Publication'), source: 'model', reviewer: 'mock', itemId: 'x' };
  const ruling = makeRuling({ finding, fingerprint: await fingerprintForFinding(finding, 'Post', 'Publier'), decision: 'approve_fix', at: '2026-10-24T12:00:00Z' });
  // maxLength is authoritative over the short English source's ratio.
  const context = new Map([[pathKey(['post']), { maxLength: 20 }]]);
  return { source, doc, finding, ruling, context };
}
it('preserves every byte outside the replaced original value range, including CRLF and BOM', async () => {
  const c = await setup('\uFEFF{\r\n  "post": "Publier",\r\n  "untouched": "é"\r\n}\r\n');
  const r = await applyApprovedFixes(c.doc, [c], { source: c.source, context: c.context });
  expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.refused);
  expect(r.applied).toHaveLength(1); const edit = r.applied[0]!; const offset = edit.offset + 1;
  const original = '\uFEFF' + c.doc.text;
  expect(bytes(r.text.slice(0, offset))).toEqual(bytes(original.slice(0, offset)));
  expect(bytes(r.text.slice(offset + JSON.stringify(edit.value).length))).toEqual(bytes(original.slice(offset + edit.length)));
  expect(JSON.parse(r.text.slice(1)).post).toBe('Publication');
});
it('refuses duplicate-key and syntax-error files', async () => {
  for (const text of ['{"post":"Publier","post":"Publier"}', '{"post":"Publier",}']) {
    const c = await setup(text); const r = await applyApprovedFixes(c.doc, [c], { source: c.source, context: c.context });
    expect(r.ok).toBe(false); expect(r.applied).toEqual([]);
  }
});
it('never applies stale fingerprints or a changed suggestion hash', async () => {
  const c = await setup();
  for (const ruling of [{ ...c.ruling, itemFingerprint: 'f'.repeat(64) }, { ...c.ruling, suggestionHash: 'f'.repeat(64) }]) {
    const r = await applyApprovedFixes(c.doc, [{ finding: c.finding, ruling }], { source: c.source, context: c.context });
    expect(r.applied).toEqual([]); expect(r.skipped[0]?.reason).toMatch(/stale_fingerprint|suggestion_hash_mismatch/u);
  }
});
it('re-runs the gate with current context and rejects secrets in metadata', async () => {
  const c = await setup();
  const context = new Map([[pathKey(['post']), { maxLength: 20, note: 'synthetic.person@example.invalid' }]]);
  const r = await applyApprovedFixes(c.doc, [c], { source: c.source, context });
  expect(r.applied).toEqual([]); expect(r.skipped[0]?.gateReasons).toContain('fix_not_allowed_redacted');
});
it('does not insert absent keys or apply competing approvals', async () => {
  const c = await setup('{"untouched":"é"}');
  const missing = await applyApprovedFixes(c.doc, [c], { source: c.source, context: c.context });
  expect(missing.applied).toEqual([]); expect(missing.skipped[0]?.reason).toBe('key_not_in_target');
  const d = await setup(); const competing = await applyApprovedFixes(d.doc, [d, d], { source: d.source, context: d.context });
  expect(competing.applied).toEqual([]); expect(competing.skipped.every((s) => s.reason === 'competing_approvals')).toBe(true);
});
it('never exports an unsupported claim even if suggestion fields are supplied', async () => {
  const c = await setup();
  const r = await applyApprovedFixes(c.doc, [{ ...c, finding: { ...c.finding, evidenceStatus: 'unsupported' } }], { source: c.source, context: c.context });
  expect(r.applied).toEqual([]); expect(r.skipped[0]?.reason).toBe('no_suggestion');
});
