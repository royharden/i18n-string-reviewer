import { displayPath } from '../core/l10nchecks/paths.ts';
import type { ValidationReport } from '../core/l10nchecks/parse.ts';
import type { Dialect } from '../core/l10nchecks/types.ts';
import type { MetaInput } from '../core/review/pipeline.ts';
import { DIALECT_LABELS } from './helpers.ts';
import type { StagedFile } from './helpers.ts';

interface Props {
  source: StagedFile | null;
  targets: readonly StagedFile[];
  context: MetaInput | null;
  glossary: MetaInput | null;
  busy: boolean;
  ready: boolean;
  onFiles: (role: 'source' | 'target' | 'context' | 'glossary', files: FileList | null) => void;
  onUpdate: (id: string, change: Partial<Pick<StagedFile, 'locale' | 'dialect' | 'confirmed'>>) => void;
  onRemove: (id: string) => void;
  onImport: () => void;
}

export function ImportPanel({ source, targets, context, glossary, busy, ready, onFiles, onUpdate, onRemove, onImport }: Props) {
  const files = [...(source ? [source] : []), ...targets];
  return <section className="panel import-panel" aria-labelledby="import-title">
    <div className="section-heading"><div><span className="eyebrow">01 / Bring your strings</span><h2 id="import-title">Start with your locale files</h2></div><span className="badge">JSON · UTF-8</span></div>
    <p className="muted">One source, up to ten target locales. Files stay in this browser during local checks and recorded mock review.</p>
    <div className="upload-grid">
      <label className="upload-card"><span className="upload-icon" aria-hidden="true">↑</span><strong>Source locale</strong><span>{source?.fileName ?? 'Choose one JSON file'}</span><input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => { onFiles('source', e.currentTarget.files); e.currentTarget.value = ''; }} /></label>
      <label className="upload-card"><span className="upload-icon" aria-hidden="true">＋</span><strong>Target locales</strong><span>{targets.length ? `${targets.length} of 10 files selected` : 'Choose up to 10 JSON files'}</span><input type="file" accept=".json,application/json" multiple disabled={busy} onChange={(e) => { onFiles('target', e.currentTarget.files); e.currentTarget.value = ''; }} /></label>
    </div>
    <div className="metadata-row">
      {(['context', 'glossary'] as const).map((kind) => <label className="metadata-upload" key={kind}><strong>{kind === 'context' ? 'Context' : 'Glossary'}</strong><span>{(kind === 'context' ? context : glossary)?.fileName ?? 'Optional JSON'}</span><input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => { onFiles(kind, e.currentTarget.files); e.currentTarget.value = ''; }} /></label>)}
    </div>
    {files.length > 0 && <div className="file-confirmations"><p className="hint">Confirm each locale and syntax. Source and targets must use the same dialect for comparison. Suggestions are a starting point.</p>
      {files.map((file) => <fieldset className={`file-row ${file.confirmed ? 'confirmed' : ''}`} key={file.id} disabled={busy}>
        <legend className="sr-only">Configure {file.fileName}</legend><div className="file-name"><strong>{file.fileName}</strong><span>{source?.id === file.id ? 'SOURCE' : 'TARGET'} · {(file.bytes.length / 1024).toFixed(1)} KB</span></div>
        <label>Locale<input value={file.locale} placeholder="e.g. fr-CA" spellCheck={false} aria-label={`Locale for ${file.fileName}`} onChange={(e) => onUpdate(file.id, { locale: e.target.value, confirmed: false })} /></label>
        <label>Message syntax<select value={file.dialect} title={file.suggestion} onChange={(e) => onUpdate(file.id, { dialect: e.target.value as Dialect, confirmed: false })}>{Object.entries(DIALECT_LABELS).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
        <label className="check-label"><input type="checkbox" checked={file.confirmed} onChange={(e) => onUpdate(file.id, { confirmed: e.target.checked })} />Confirmed</label><button className="icon-button" type="button" aria-label={`Remove ${file.fileName}`} onClick={() => onRemove(file.id)}>×</button>
      </fieldset>)}
    </div>}
    <div className="panel-footer"><span className="hint">2 MB per file · 5,000 keys · nested or flat JSON</span><button className="primary" disabled={!ready || busy} onClick={onImport}>Validate & check <span aria-hidden="true">→</span></button></div>
  </section>;
}

export function ValidationPanel({ report }: { report: ValidationReport }) {
  return <section className="panel validation-panel" aria-labelledby="validation-title"><div className="section-heading"><div><span className="eyebrow">Import report</span><h2 id="validation-title">Every file accounted for</h2></div><span className={`badge ${report.errorCount ? 'badge-red' : 'badge-green'}`}>{report.errorCount} errors · {report.warningCount} warnings</span></div>
    {report.files.map((file, index) => <details className="file-report" key={`${file.fileName}-${index}`} open={file.issues.length > 0}><summary><span><strong>{file.fileName}</strong><span className="muted"> {file.locale} · {file.role ?? file.kind}</span></span><span className={`status status-${file.status}`}>{file.status}</span></summary>
      {file.issues.length ? <ul>{file.issues.map((issue, i) => <li key={i}><span className={`issue-level ${issue.severity}`}>{issue.severity}</span><code>{issue.code}</code>{issue.path && <code>{displayPath(issue.path)}</code>}<span>{issue.message}</span></li>)}</ul> : <p className="hint">Imported successfully.</p>}
      {(file.status === 'ineligible' || file.status === 'rejected') && <p className="notice-inline">Model review and patched download are disabled for this file. Correct the reported issues and re-import it.</p>}
    </details>)}
  </section>;
}
