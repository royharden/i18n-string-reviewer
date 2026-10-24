import { useEffect, useState } from 'react';
import type { Finding } from '../core/cited/finding.ts';
import { displayPath } from '../core/l10nchecks/paths.ts';
import type { FindingTexts } from '../core/review/pipeline.ts';
import type { RulingDecision, RulingState } from '../core/rulings/rulings.ts';
import { showBidi, textDiff } from './helpers.ts';

interface Props {
  finding: Finding;
  texts: FindingTexts | undefined;
  state: RulingState | undefined;
  bidi: boolean;
  busy: boolean;
  canEdit: boolean;
  onDecide: (decision: RulingDecision) => void;
  onEdit: (text: string) => void;
}

export function FindingDetail({ finding, texts, state, bidi, busy, canEdit, onDecide, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(texts?.targetText ?? '');
  useEffect(() => { setEditing(false); setDraft(texts?.targetText ?? ''); }, [finding.id, texts?.targetText]);
  const target = texts?.targetText ?? '';
  const offset = finding.evidenceOffset;
  const highlight = finding.evidenceStatus === 'supported' && offset !== undefined && target.slice(offset, offset + finding.evidence.length) === finding.evidence;
  const diff = finding.suggestedFix !== undefined ? textDiff(target, finding.suggestedFix) : null;
  const decisionLabel: Readonly<Record<RulingDecision, string>> = { approve_fix: 'Fix approved', accept_finding: 'Finding accepted', reject: 'Rejected', skip: 'Skipped' };
  return <article className="finding-detail" aria-labelledby="detail-title">
    <div className="detail-heading"><div className="badge-row"><span className={`badge ${finding.level === 'error' || finding.severity === 'critical' ? 'badge-red' : 'badge-amber'}`}>{finding.level ?? finding.severity}</span><span className="badge">{finding.locale}</span><span className="badge">{finding.source === 'static' ? 'Deterministic' : 'Recorded mock'}</span></div><h3 id="detail-title">{(finding.ruleId ?? finding.category).replace(/_/gu, ' ')}</h3><code className="key-path">{displayPath(finding.key)}</code></div>
    <p className="finding-explanation">{finding.explanation}</p>
    {state && <div className={`decision-notice ${state.status === 'active' ? 'decided' : 'invalidated'}`}>{state.status === 'active' ? decisionLabel[state.ruling.decision] : state.status === 'invalidated_text' ? 'Invalidated — text changed. Review this finding again.' : 'Invalidated — suggestion changed. Approve the new fix explicitly.'}</div>}
    <div className="comparison-grid"><section className="string-card"><div className="string-label"><span>Source</span><span>{texts?.fileName ? 'Reference text' : 'Source issue'}</span></div><div className="string-text" dir="auto">{showBidi(texts?.sourceText ?? '', bidi) || <span className="muted">No source string at this path</span>}</div></section><section className="string-card target-card"><div className="string-label"><span>Target · {finding.locale}</span><span>{texts?.targetPresent === false ? 'Missing / non-string' : 'Current text'}</span></div><div className="string-text" dir="auto">{highlight && offset !== undefined ? <>{showBidi(target.slice(0, offset), bidi)}<mark>{showBidi(finding.evidence, bidi)}</mark>{showBidi(target.slice(offset + finding.evidence.length), bidi)}</> : showBidi(target, bidi) || <span className="muted">No target string at this path</span>}</div></section></div>
    <div className={`evidence-note ${finding.evidenceStatus === 'unsupported' ? 'unsupported' : ''}`}><strong>{finding.evidenceStatus === 'supported' ? 'Supported evidence' : 'Unsupported evidence'}</strong><span>{finding.evidenceStatus === 'unsupported' ? 'The claim could not be located uniquely in the target. No fix can be approved.' : highlight ? 'Highlighted at its validated position in the current target.' : 'A structural or file-level finding; no unique text span to highlight.'}</span>{finding.evidenceStatus === 'unsupported' && finding.evidence && <q dir="auto">{showBidi(finding.evidence, bidi)}</q>}</div>
    {diff && <section className="fix-panel"><div className="section-heading"><h4>Suggested fix</h4><span className="badge badge-green">Gate accepted</span></div><div className="diff-line" dir="auto"><span className="diff-sign" aria-label="Before">−</span>{showBidi(diff.prefix, bidi)}<del>{showBidi(diff.removed, bidi)}</del>{showBidi(diff.suffix, bidi)}</div><div className="diff-line" dir="auto"><span className="diff-sign" aria-label="After">+</span>{showBidi(diff.prefix, bidi)}<ins>{showBidi(diff.added, bidi)}</ins>{showBidi(diff.suffix, bidi)}</div><p className="hint">Approval records this exact suggestion. Download checks its fingerprint and structure again.</p></section>}
    {!diff && <div className="no-fix">Finding only. Accepting it records your decision; it does not change a translation.</div>}
    <div className="decision-actions"><button className="primary" disabled={busy} onClick={() => onDecide(diff ? 'approve_fix' : 'accept_finding')}>{diff ? 'Approve fix' : 'Accept finding'} <kbd>A</kbd></button><button disabled={busy} onClick={() => onDecide('reject')}>Reject <kbd>R</kbd></button><button className="quiet" disabled={busy} onClick={() => onDecide('skip')}>Skip <kbd>S</kbd></button></div>
    {canEdit && <details className="edit-section" open={editing} onToggle={(e) => setEditing(e.currentTarget.open)}><summary>Edit the target string</summary><p className="hint">Editing re-imports the file and rechecks it. Previous decisions remain in history and are invalidated when their text changes.</p><label className="sr-only" htmlFor="target-draft">Target string</label><textarea id="target-draft" value={draft} dir="auto" spellCheck={false} disabled={busy} onChange={(e) => setDraft(e.target.value)} /><button disabled={busy || draft === target} onClick={() => onEdit(draft)}>Save edit & recheck</button></details>}
  </article>;
}
