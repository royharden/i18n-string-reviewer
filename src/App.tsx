import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sortFindingsForReview } from './core/cited/finding.ts';
import { applyApprovedFixes, replaceStringValue } from './core/export/patch.ts';
import { validateLocale } from './core/l10nchecks/locale.ts';
import { formatValidationReport } from './core/l10nchecks/parse.ts';
import { displayPath, parseDisplayPath } from './core/l10nchecks/paths.ts';
import { importFiles, MAX_TARGETS, preparePipeline, runPipeline, runPreparedPipeline } from './core/review/pipeline.ts';
import { buildHeuristicPolicies, createHeuristicReviewer } from './core/review/heuristic.ts';
import type { ImportInput, ImportResult, MetaInput, PipelineResult, ReviewScope } from './core/review/pipeline.ts';
import type { Reviewer } from './core/review/types.ts';
import { exportableApprovals, makeRuling, parseRulingsJsonl, pickCompetingApproval, replayRulings, serializeRulings } from './core/rulings/rulings.ts';
import type { Ruling, RulingDecision, RulingParseError } from './core/rulings/rulings.ts';
import { demoImport } from './ui/demo.ts';
import { FindingDetail } from './ui/FindingDetail.tsx';
import { downloadText, errorMessage, isTypingTarget, stageFile } from './ui/helpers.ts';
import type { StagedFile } from './ui/helpers.ts';
import { ImportPanel, ValidationPanel } from './ui/ImportPanel.tsx';
import { LiveReviewPanel } from './ui/LiveReviewPanel.tsx';
import './ui/styles.css';

export function App() {
  const publicLiveConfig = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
  const [source, setSource] = useState<StagedFile | null>(null);
  const [targets, setTargets] = useState<readonly StagedFile[]>([]);
  const [context, setContext] = useState<MetaInput | null>(null);
  const [glossary, setGlossary] = useState<MetaInput | null>(null);
  const [input, setInput] = useState<ImportInput | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [mock, setMock] = useState<Reviewer | null>(null);
  const [variant, setVariant] = useState(0);
  const [rulings, setRulings] = useState<readonly Ruling[]>([]);
  const [rulingErrors, setRulingErrors] = useState<readonly RulingParseError[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [localeFilter, setLocaleFilter] = useState('all');
  const [decisionFilter, setDecisionFilter] = useState('all');
  const [bidi, setBidi] = useState(true);
  const [prefix, setPrefix] = useState('');
  const [scopeLocales, setScopeLocales] = useState<readonly string[]>([]);
  const [errorFreeOnly, setErrorFreeOnly] = useState(false);
  const [mode, setMode] = useState<'local' | 'live'>('local');
  const [executedScope, setExecutedScope] = useState<ReviewScope>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const fileId = useRef(0);
  const liveCancel = useRef<(() => void) | null>(null);
  const currentScope = useMemo((): ReviewScope | null => {
    const keyPrefix = prefix.trim() ? parseDisplayPath(prefix.trim()) : undefined;
    if (keyPrefix === null) return null;
    return { locales: [...scopeLocales], errorFreeOnly, ...(keyPrefix ? { keyPrefix } : {}) };
  }, [prefix, scopeLocales, errorFreeOnly]);
  const allFindings = useMemo(() => result ? sortFindingsForReview([...result.findings, ...result.sourceFindings]) : [], [result]);
  const replay = useMemo(() => replayRulings(rulings, allFindings.flatMap((finding) => {
    const fingerprint = result?.fingerprints.get(finding.id);
    return fingerprint ? [{ finding, fingerprint }] : [];
  }), result?.knownStrings), [rulings, allFindings, result]);
  const approvals = useMemo(() => exportableApprovals(replay), [replay]);
  const filtered = useMemo(() => allFindings.filter((finding) => {
    const state = replay.byFinding.get(finding.id);
    return (localeFilter === 'all' || finding.locale === localeFilter)
      && (decisionFilter !== 'pending' || !state || state.status !== 'active')
      && (decisionFilter !== 'decided' || state?.status === 'active')
      && `${displayPath(finding.key)} ${finding.explanation} ${finding.ruleId ?? finding.category}`.toLowerCase().includes(query.toLowerCase());
  }), [allFindings, replay, query, localeFilter, decisionFilter]);
  const selected = filtered.find((finding) => finding.id === selectedId) ?? filtered[0];
  const files = [...(source ? [source] : []), ...targets];
  const locales = files.map((file) => validateLocale(file.locale));
  const canonicalTargets = targets.map((file) => validateLocale(file.locale)).flatMap((locale) => locale.ok ? [locale.canonical] : []);
  const commonDialect = source !== null && targets.every((target) => target.dialect === source.dialect);
  const ready = source !== null && targets.length > 0 && files.every((file) => file.confirmed) && locales.every((locale) => locale.ok) && commonDialect && new Set(canonicalTargets).size === targets.length;

  function invalidate(): void {
    generation.current++;
    setImported(null); setInput(null); setResult(null); setSelectedId(null); setMock(null); setError(''); setMessage('Files changed. Confirm the configuration, then validate and check again.');
  }

  async function receiveFiles(role: 'source' | 'target' | 'context' | 'glossary', list: FileList | null): Promise<void> {
    if (!list?.length) return;
    const selectedFiles = Array.from(list);
    const token = ++generation.current;
    setBusy(true); setError('');
    try {
      if (role === 'target' && targets.length + selectedFiles.length > MAX_TARGETS) throw new Error('Choose no more than 10 target files in total. Remove a target before adding another.');
      if (selectedFiles.some((file) => file.size > 2 * 1024 * 1024)) throw new Error('Each file must be 2 MB or smaller.');
      const loaded = await Promise.all(selectedFiles.map(async (file) => ({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
      if (generation.current !== token) return;
      invalidate();
      if (role === 'source' && loaded[0]) setSource(stageFile(loaded[0].fileName, loaded[0].bytes, `file-${++fileId.current}`, 'source'));
      if (role === 'target') setTargets((previous) => [...previous, ...loaded.map((file) => stageFile(file.fileName, file.bytes, `file-${++fileId.current}`, 'target'))]);
      if (role === 'context') setContext(loaded[0] ?? null);
      if (role === 'glossary') setGlossary(loaded[0] ?? null);
    } catch (cause) { if (generation.current === token) setError(errorMessage(cause)); }
    finally { if (generation.current === token || generation.current === token + 1) setBusy(false); }
  }

  function updateFile(id: string, change: Partial<Pick<StagedFile, 'locale' | 'dialect' | 'confirmed'>>): void {
    invalidate();
    setSource((file) => file?.id === id ? { ...file, ...change } : file);
    setTargets((previous) => previous.map((file) => file.id === id ? { ...file, ...change } : file));
  }

  async function review(nextImport: ImportResult, reviewer?: Reviewer | 'heuristic', nextVariant = 0, scope?: ReviewScope): Promise<void> {
    const token = ++generation.current;
    setBusy(true); setError(''); setResult(null); setSelectedId(null);
    try {
      let next: PipelineResult;
      if (reviewer === 'heuristic') {
        const prepared = await preparePipeline(nextImport, { ...(scope ? { scope } : {}) });
        const local = createHeuristicReviewer({ policies: buildHeuristicPolicies(prepared.batches.flat(), nextImport.glossary) });
        const completed = await runPreparedPipeline(prepared, { reviewer: local, shouldCancel: () => token !== generation.current });
        if (completed.completion === 'error') throw new Error(completed.error ?? 'Local heuristic review failed.');
        next = completed;
      } else {
        next = await runPipeline(nextImport, { ...(reviewer ? { reviewer, reviewOptions: { variant: nextVariant } } : {}), ...(scope ? { scope } : {}) });
      }
      if (token !== generation.current) return;
      setResult(next); setVariant(nextVariant); setExecutedScope(scope ?? {});
      setMessage(`${next.findings.length + next.sourceFindings.length} findings from ${reviewer === 'heuristic' ? 'deterministic checks and the local heuristic comparison floor' : reviewer ? 'deterministic checks and recorded mock replies' : 'deterministic checks'}. Review decisions before downloading changes.`);
    } catch (cause) { if (token === generation.current) setError(errorMessage(cause)); }
    finally { if (token === generation.current) setBusy(false); }
  }

  function importStaged(): void {
    if (!ready || !source) return;
    try {
      const canonical = (file: StagedFile) => { const locale = validateLocale(file.locale); return { ...file, locale: locale.ok ? locale.canonical : file.locale }; };
      const nextInput: ImportInput = { source: canonical(source), targets: targets.map(canonical), ...(context ? { context } : {}), ...(glossary ? { glossary } : {}) };
      const next = importFiles(nextInput);
      setInput(nextInput); setImported(next); setMock(null); setLocaleFilter('all'); setScopeLocales(next.targets.map((target) => target.locale));
      void review(next);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  function loadDemo(setId: string, broken = false): void {
    try {
      const demo = demoImport(setId, broken);
      const stage = (file: ImportInput['source']): StagedFile => ({ ...file, id: `file-${++fileId.current}`, confirmed: true, suggestion: 'Pinned by the demo manifest' });
      setSource(stage(demo.input.source)); setTargets(demo.input.targets.map(stage)); setContext(demo.input.context ?? null); setGlossary(demo.input.glossary ?? null);
      setInput(demo.input); setImported(demo.imported); setMock(demo.reviewer); setLocaleFilter('all'); setScopeLocales(demo.imported.targets.map((target) => target.locale)); setPrefix(''); setErrorFreeOnly(false);
      void review(demo.imported);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  function mockReview(nextVariant: number): void {
    if (!imported || !mock) return;
    const keyPrefix = prefix.trim() ? parseDisplayPath(prefix.trim()) : undefined;
    if (keyPrefix === null) { setError('Use a dot-separated key prefix or a JSON array of path segments.'); return; }
    void review(imported, mock, nextVariant, { locales: scopeLocales, errorFreeOnly, ...(keyPrefix ? { keyPrefix } : {}) });
  }

  function heuristicReview(): void {
    if (!imported) return;
    if (!currentScope) { setError('Use a dot-separated key prefix or a JSON array of path segments.'); return; }
    void review(imported, 'heuristic', 0, currentScope);
  }

  const decide = useCallback((decision: RulingDecision): void => {
    if (!selected || !result) return;
    const fingerprint = result.fingerprints.get(selected.id);
    if (!fingerprint) return;
    try {
      const ruling = makeRuling({ finding: selected, fingerprint, decision, at: new Date().toISOString() });
      setRulings((previous) => [...previous, ruling]); setMessage(`Decision saved for ${displayPath(selected.key)} (${selected.locale}).`);
    } catch (cause) { setError(errorMessage(cause)); }
  }, [selected, result]);
  const move = useCallback((delta: number): void => {
    if (!filtered.length) return;
    const index = selected ? filtered.findIndex((finding) => finding.id === selected.id) : 0;
    setSelectedId(filtered[Math.max(0, Math.min(filtered.length - 1, index + delta))]?.id ?? null);
  }, [filtered, selected]);
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (busy || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'j' || key === 'k') { event.preventDefault(); move(key === 'j' ? 1 : -1); }
      if (selected && ['a', 'r', 's'].includes(key)) { event.preventDefault(); decide(key === 'a' ? selected.suggestedFix !== undefined ? 'approve_fix' : 'accept_finding' : key === 'r' ? 'reject' : 'skip'); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [busy, selected, decide, move]);

  async function editTarget(value: string): Promise<void> {
    if (!selected || !input || !imported || !result) return;
    const doc = imported.targets.find((target) => target.locale === selected.locale);
    if (!doc) return;
    try {
      const changed = replaceStringValue(doc, selected.key, value);
      if (!changed.ok) throw new Error(changed.reason);
      const bytes = new TextEncoder().encode(changed.text);
      const nextInput = { ...input, targets: input.targets.map((target) => target.locale.toLowerCase() === doc.locale.toLowerCase() ? { ...target, bytes } : target) };
      const next = importFiles(nextInput);
      setInput(nextInput); setImported(next); setTargets((previous) => previous.map((target) => { const locale = validateLocale(target.locale); return locale.ok && locale.canonical === doc.locale ? { ...target, bytes } : target; }));
      // Editing can replay the completed local pass without initiating another paid call.
      await review(next, result.reviewer === 'heuristic' ? 'heuristic' : result.reviewer === 'mock' && mock ? mock : undefined, variant, executedScope);
      if (result.reviewer === 'llm') setMessage('Target edited and checked locally. Live review requires a fresh preview and explicit paid-run confirmation.');
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function importRulings(list: FileList | null): Promise<void> {
    const file = list?.[0];
    if (!file) return;
    const token = ++generation.current;
    setBusy(true); setError('');
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Rulings import must be 2 MB or smaller.');
      const parsed = parseRulingsJsonl(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      if (generation.current !== token) return;
      setRulings((previous) => [...previous, ...parsed.rulings]); setRulingErrors(parsed.errors);
      setMessage(`Imported ${parsed.rulings.length} rulings; ${parsed.errors.length} bad lines skipped. Decisions are replayed against current text and suggestions.`);
    } catch (cause) { if (generation.current === token) setError(errorMessage(cause)); }
    finally { if (generation.current === token) setBusy(false); }
  }

  async function downloadPatch(locale: string): Promise<void> {
    if (!imported || !result || result.invariantViolations.length || replay.competing.size) return;
    const doc = imported.targets.find((target) => target.locale === locale);
    if (!doc) return;
    const token = generation.current;
    setBusy(true); setError('');
    try {
      const fixes = approvals.flatMap((state) => {
        const finding = result.findings.find((candidate) => candidate.id === state.ruling.findingId && candidate.locale === locale);
        return finding ? [{ finding, ruling: state.ruling }] : [];
      });
      const patch = await applyApprovedFixes(doc, fixes, { source: imported.source, context: imported.context, glossary: imported.glossary });
      if (token !== generation.current) return;
      if (!patch.ok) throw new Error(patch.refused);
      if (!patch.applied.length) throw new Error(`No fixes passed export validation.${patch.skipped.length ? ` Skipped: ${patch.skipped.map((fix) => fix.reason).join(', ')}.` : ''}`);
      downloadText(doc.fileName.replace(/\.json$/iu, '') + '.patched.json', patch.text);
      setMessage(`Downloaded ${doc.fileName}: ${patch.applied.length} approved fixes applied; ${patch.skipped.length} skipped.${patch.skipped.length ? ` Reasons: ${patch.skipped.map((fix) => fix.reason).join(', ')}.` : ''}`);
    } catch (cause) { if (token === generation.current) setError(errorMessage(cause)); }
    finally { if (token === generation.current) setBusy(false); }
  }

  const decidedCount = [...replay.byFinding.values()].filter((state) => state.status === 'active').length;
  const errorsCount = allFindings.filter((finding) => finding.level === 'error').length;
  const invalidated = [...replay.byFinding.values()].filter((state) => state.status !== 'active').length + [...replay.invalidatedStrings.values()].reduce((sum, entries) => sum + entries.length, 0);

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#top"><span className="brand-icon" aria-hidden="true">文<span>✓</span></span><span>String<span className="brand-light">review</span><small>LOCALIZATION WORKSPACE</small></span></a><div className="topbar-meta"><span className="local-dot" />Local-first review<span className="version">BETA</span></div></header>
    <main id="top">
      <section className="hero"><div><span className="eyebrow">Meaning matters. Structure stays.</span><h1>Confidence in every<br /><span>translated string.</span></h1><p>Catch broken placeholders, spot changes in meaning, and review every fix before it reaches your locale files.</p></div><div className="hero-card"><span className="mini-label">YOUR REVIEW FLOW</span><ol><li><span>01</span>Import & validate</li><li><span>02</span>Inspect the evidence</li><li><span>03</span>Approve & download</li></ol><div className="hero-card-bottom"><span aria-hidden="true">◇</span> Your files. Your final say.</div></div></section>
      <div className="mode-banner"><div><strong><span className="local-dot" />{mode === 'local' ? publicLiveConfig ? 'Local mode — checks, heuristic and recorded mock review' : 'Local mode — live review not configured' : 'Live mode — sign-in, preview and permission required'}</strong><span>{mode === 'local' ? 'Deterministic checks stay in this browser. Demo review replays authored responses.' : 'Backend transfers and paid provider execution require separate confirmation. Live failures never use mock results.'}</span></div><span className="badge">{mode === 'local' ? 'No API key needed' : 'Server-metered'}</span></div>
      <section className="demo-strip" aria-label="Demo data"><div><strong>Take a guided first look</strong><span>Seeded TaskBoard strings with intentional issues.</span></div><div className="button-row"><button disabled={busy} onClick={() => loadDemo('demo-icu')}>Load demo <span aria-hidden="true">↗</span></button><button className="quiet" disabled={busy} onClick={() => loadDemo('demo-i18next')}>i18next example</button><button className="quiet" disabled={busy} onClick={() => loadDemo('demo-icu', true)}>Load broken file</button></div></section>
      <ImportPanel source={source} targets={targets} context={context} glossary={glossary} busy={busy} ready={ready} onFiles={(role, list) => { void receiveFiles(role, list); }} onUpdate={updateFile} onRemove={(id) => { invalidate(); setSource((file) => file?.id === id ? null : file); setTargets((previous) => previous.filter((file) => file.id !== id)); }} onImport={importStaged} />
      {files.length > 0 && !ready && <p className="configuration-hint">{!commonDialect && source && targets.length ? 'Choose the same message syntax for source and all targets.' : locales.some((locale) => !locale.ok) ? 'Enter a supported BCP-47 locale for every file.' : new Set(canonicalTargets).size !== targets.length ? 'Each target must have a different locale.' : 'Select a source and at least one target, then confirm every file to enable checks.'}</p>}
      <div className="feedback" aria-live="polite" role="status">{busy ? <span className="working"><span className="spinner" />Working on your review… <button className="text-button" onClick={() => { if (liveCancel.current) { liveCancel.current(); return; } generation.current++; setBusy(false); setMessage('Operation cancelled. Run checks again when ready.'); }}>Cancel</button></span> : message}</div>
      {error && <div className="error-banner" role="alert"><strong>Couldn’t complete that step.</strong> {error}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {imported && <ValidationPanel report={imported.report} />}
      {imported && <section className="panel review-controls"><div className="section-heading"><div><span className="eyebrow">02 / Review with evidence</span><h2>Choose your review pass</h2></div><div className="button-row"><button disabled={busy} onClick={() => { void review(imported); }}>Deterministic checks</button><button disabled={busy || mode !== 'local'} onClick={heuristicReview}>Heuristic (local)</button><button className="primary" disabled={busy || !mock || mode !== 'local'} onClick={() => mockReview(0)}>Review strings (mock) <span aria-hidden="true">→</span></button></div></div><p className="muted">{mock ? 'The recorded reviewer exercises contextual findings and hostile proposals. Every proposed fix still passes the same code gate.' : 'Your files are ready for local checks. Recorded mock responses are available for the bundled demos.'}</p>
        <p className="hint">The local heuristic is a non-model comparison floor for identical text, glossary, length and script hints; it does not measure semantic quality.</p><div className="button-row"><button disabled title="Requires real dev probe and held-out comparison">Jev (experimental, disabled)</button><button disabled title="Requires real dev probe and held-out comparison">Jev → LLM (experimental, disabled)</button></div><p className="hint">Experimental thresholds, recall floor and injection tolerance are provisional and unmeasured. These methods remain disabled until the dev probe and held-out recall/cost criteria are met.</p>
        <div className="mode-switch" aria-label="Review mode"><button disabled={busy} aria-pressed={mode === 'local'} onClick={() => setMode('local')}>Local / recorded mock</button><button disabled={busy} aria-pressed={mode === 'live'} onClick={() => setMode('live')}>Live / metered</button></div>
        <details className="scope-controls"><summary>Review scope & alternatives</summary><div className="scope-grid"><fieldset><legend>Target locales for the optional review pass</legend>{imported.targets.map((target) => <label className="check-label" key={target.locale}><input type="checkbox" checked={scopeLocales.includes(target.locale)} disabled={busy} onChange={(e) => setScopeLocales((previous) => e.target.checked ? [...previous, target.locale] : previous.filter((locale) => locale !== target.locale))} />{target.locale}</label>)}</fieldset><label>Key prefix<input value={prefix} placeholder={'checkout or ["literal.key"]'} disabled={busy} onChange={(e) => setPrefix(e.target.value)} /></label><label className="check-label"><input type="checkbox" checked={errorFreeOnly} disabled={busy} onChange={(e) => setErrorFreeOnly(e.target.checked)} />Only strings without deterministic errors</label></div><p className="hint">Scope limits the optional reviewer pass. Deterministic checks cover every imported file.</p><button disabled={busy || !mock || mode !== 'local'} onClick={() => mockReview(variant + 1)}>Regenerate recorded alternatives</button><p className="hint">A changed suggestion invalidates its previous approval.</p></details>
        {mode === 'live' && <LiveReviewPanel imported={imported} scope={currentScope} busy={busy} onBusy={(working, cancel) => { liveCancel.current = cancel ?? null; setBusy(working); }} onComplete={(completed, scope) => { setResult(completed); setExecutedScope(scope); setSelectedId(null); setMessage(`Live review ${completed.completion}: ${completed.completedBatches} of ${completed.totalBatches} batches completed. Completed results remain reviewable.`); }} />}
      </section>}
      {result && <>
        <p className="hint result-origin">Current results: deterministic checks{result.reviewer ? ` + ${result.reviewer === 'mock' ? 'recorded mock review' : result.reviewer === 'llm' ? 'live review (see batch completion status)' : result.reviewer === 'heuristic' ? 'local heuristic comparison floor' : result.reviewer}` : ''}.{mode === 'live' && result.reviewer !== 'llm' ? ' These results are from the previous local pass.' : ''}</p>
        <div className="stats-grid"><div><span>Total findings</span><strong>{allFindings.length}</strong><small>{result.sourceFindings.length} source issues</small></div><div><span>Structural errors</span><strong className={errorsCount ? 'red-text' : ''}>{errorsCount}</strong><small>Deterministic checks</small></div><div><span>Review progress</span><strong>{decidedCount}<em> / {allFindings.length}</em></strong><small>Decisions recorded</small></div><div><span>Approved fixes</span><strong className="green-text">{approvals.length}</strong><small>Ready for export validation</small></div></div>
        {result.invariantViolations.length > 0 && <div className="error-banner" role="alert">An invariant check failed. Patched downloads are blocked; inspect the report before continuing.</div>}
        <section className="panel workspace" aria-labelledby="workspace-title"><div className="workspace-heading"><div><span className="eyebrow">The review desk</span><h2 id="workspace-title">Findings <span className="count-pill">{filtered.length}</span></h2></div><label className="check-label"><input type="checkbox" checked={bidi} onChange={(e) => setBidi(e.target.checked)} />Show bidi controls</label></div><div className="workspace-grid"><aside className="queue"><div className="queue-filters"><label className="sr-only" htmlFor="finding-search">Search findings</label><input id="finding-search" type="search" placeholder="Search keys or findings…" value={query} onChange={(e) => setQuery(e.target.value)} /><div><label className="sr-only" htmlFor="locale-filter">Filter locale</label><select id="locale-filter" value={localeFilter} onChange={(e) => setLocaleFilter(e.target.value)}><option value="all">All locales</option>{[...new Set(allFindings.map((finding) => finding.locale))].map((locale) => <option key={locale}>{locale}</option>)}</select><label className="sr-only" htmlFor="decision-filter">Filter decisions</label><select id="decision-filter" value={decisionFilter} onChange={(e) => setDecisionFilter(e.target.value)}><option value="all">All decisions</option><option value="pending">Needs review</option><option value="decided">Decided</option></select></div><span className="hint">Errors first · <kbd>J</kbd> next · <kbd>K</kbd> previous</span></div><nav className="finding-list" aria-label="Findings">{filtered.map((finding) => { const state = replay.byFinding.get(finding.id); return <button className={`finding-row ${selected?.id === finding.id ? 'selected' : ''}`} key={finding.id} aria-current={selected?.id === finding.id ? 'true' : undefined} onClick={() => setSelectedId(finding.id)}><span className="finding-row-top"><span className={`severity-dot ${finding.level === 'error' || finding.severity === 'critical' ? 'error' : finding.source === 'model' ? 'model' : 'warning'}`} /><strong>{(finding.ruleId ?? finding.category).replace(/_/gu, ' ')}</strong><span>{finding.locale}</span></span><code>{displayPath(finding.key)}</code><span className="row-status">{state?.status === 'active' ? state.ruling.decision.replace(/_/gu, ' ') : state ? 'Decision invalidated' : finding.suggestedFix !== undefined ? 'Fix available' : finding.evidenceStatus === 'unsupported' ? 'Unsupported evidence' : 'Needs review'}</span></button>; })}{!filtered.length && <div className="queue-empty">{allFindings.length ? 'No findings match these filters.' : 'No findings in this pass.'}</div>}</nav></aside><div className="detail-area">{selected ? <FindingDetail finding={selected} texts={result.texts.get(selected.id)} state={replay.byFinding.get(selected.id)} bidi={bidi} busy={busy} canEdit={Boolean(result.texts.get(selected.id)?.targetPresent && imported?.targets.some((target) => target.locale === selected.locale && target.eligible.export))} onDecide={decide} onEdit={(text) => { void editTarget(text); }} /> : <div className="empty-review"><span aria-hidden="true">✓</span><h3>{allFindings.length ? 'A little less noise.' : 'No findings from this pass.'}</h3><p>{allFindings.length ? 'Adjust the filters to return to your review queue.' : 'Review coverage depends on the checks and data provided. This is not a guarantee of translation quality.'}</p></div>}</div></div></section>
        <section className="panel gate-panel"><details><summary><span><strong>Gate rejections</strong><span className="muted"> Proposed changes blocked by code</span></span><span className="count-pill">{result.rejections.length}</span></summary><p className="hint">Rejected proposals are never available for approval or patched export. Reviewer claims can remain visible as findings.</p><div className="gate-counters">{Object.entries(result.gate.byReason).filter(([, count]) => count > 0).map(([reason, count]) => <span className="badge badge-red" key={reason}>{reason}: {count}</span>)}</div>{result.rejections.map((rejection, index) => <div className="rejection" key={`${rejection.findingId}-${index}`}><div><strong>{rejection.locale}</strong> <code>{displayPath(rejection.key)}</code></div><p>{rejection.reasons.join(' · ')}</p><pre dir="auto">{rejection.proposal}</pre></div>)}{!result.rejections.length && <p className="muted">No proposals were rejected in this pass.</p>}<p className="hint">Batch validation dropped {result.dropped} replies. Duplicate findings: {result.duplicateFindings}. Accepted-fix invariant violations: {result.invariantViolations.length}.</p></details></section>
      </>}
      <section className="panel decisions-panel"><div className="section-heading"><div><span className="eyebrow">03 / Keep the human decision</span><h2>Rulings & downloads</h2></div><span className="badge">{rulings.length} history entries</span></div><p className="muted">Decisions live in this tab until downloaded. Re-import a rulings file to resume; changed text and suggestions require a fresh decision.</p><div className="button-row"><label className="button-like">Import rulings<input type="file" accept=".jsonl,.ndjson,.txt,application/x-ndjson" disabled={busy} onChange={(e) => { void importRulings(e.currentTarget.files); e.currentTarget.value = ''; }} /></label><button disabled={!rulings.length || busy} onClick={() => downloadText('rulings.jsonl', serializeRulings(rulings), 'application/x-ndjson')}>Download rulings.jsonl <span aria-hidden="true">↓</span></button><button disabled={!result || busy} onClick={() => downloadText('findings.json', JSON.stringify(allFindings, null, 2) + '\n')}>Download findings.json <span aria-hidden="true">↓</span></button><button className="quiet" disabled={!imported || busy} onClick={() => { if (imported) downloadText('validation-report.txt', formatValidationReport(imported.report), 'text/plain'); }}>Import report ↓</button></div>
        {rulingErrors.length > 0 && <div className="ruling-alert" role="alert"><strong>{rulingErrors.length} invalid rulings lines skipped</strong><ul>{rulingErrors.map((issue) => <li key={issue.line}>Line {issue.line}: {issue.message}</li>)}</ul></div>}
        {result && invalidated > 0 && <div className="ruling-alert"><strong>{invalidated} decisions invalidated</strong><p>Text or suggestions changed. These decisions cannot authorize an export.</p>{[...replay.invalidatedStrings.values()].flat().map((ruling, index) => <p key={`${ruling.findingId}-${index}`}><code>{displayPath(ruling.key)}</code> · {ruling.locale} · invalidated (text changed)</p>)}</div>}
        {result && replay.orphaned.length > 0 && <p className="hint">{replay.orphaned.length} rulings refer to strings outside this import and are not applied.</p>}
        {result && replay.conflicts.length > 0 && <div className="ruling-alert"><strong>Decision history conflicts</strong>{replay.conflicts.map((conflict, index) => <p key={index}>{conflict.message}</p>)}</div>}
        {result && [...replay.competing.entries()].map(([key, ids]) => <div className="ruling-alert" key={key}><strong>Choose one approved suggestion for this string</strong><p>Patched downloads are blocked until competing approvals are resolved.</p>{ids.map((id) => { const finding = allFindings.find((entry) => entry.id === id); return <button disabled={busy} key={id} onClick={() => { try { const added = pickCompetingApproval(replay, key, id, new Date().toISOString()); setRulings((previous) => [...previous, ...added]); } catch (cause) { setError(errorMessage(cause)); } }}>{finding ? `${finding.locale} · ${displayPath(finding.key)} · ${finding.category}: ${finding.suggestedFix ?? ''}` : id}</button>; })}</div>)}
        {imported && result && <div className="patch-downloads"><h3>Patched target files</h3><p className="hint">Only current, explicitly approved fixes are applied. Original files are never overwritten.</p>{imported.targets.map((target) => { const count = approvals.filter((state) => state.ruling.locale === target.locale).length; return <div className="patch-file" key={target.locale}><div><strong>{target.fileName}</strong><span>{target.locale} · {target.eligible.export ? `${count} approved fixes` : 'Export disabled: import errors'}</span></div><button disabled={busy || !target.eligible.export || count === 0 || replay.competing.size > 0 || result.invariantViolations.length > 0} onClick={() => { void downloadPatch(target.locale); }}>Download patched ↓</button></div>; })}</div>}
      </section>
      <footer className="app-footer"><span>Stringreview <span aria-hidden="true">/</span> A careful second look.</span><span>Review only · JSON locale files · No automatic writes</span></footer>
    </main>
  </div>;
}
