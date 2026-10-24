// Compare-locales principle: error-severity rules have ZERO false positives on the clean corpus.
// Every target in fixtures/manifest.json is parsed under its pinned locale + dialect and checked
// against its corpus's source; no error-severity finding and no error-severity import issue may
// appear. Warnings are not asserted here (they are counted per 1,000 strings by the eval).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseContextFile, parseGlossaryFile } from '../../src/core/l10nchecks/metadata.ts';
import { parseLocale } from '../../src/core/l10nchecks/parse.ts';
import { runChecks } from '../../src/core/l10nchecks/runChecks.ts';
import type { Dialect, FileRole } from '../../src/core/l10nchecks/types.ts';

interface ManifestFile {
  path: string;
  locale: string;
  dialect: Dialect;
  role: FileRole;
  corpus: string;
}
interface Manifest {
  files: ManifestFile[];
  context: string;
  glossary: string;
}

const repoRoot = new URL('../../', import.meta.url);
const readBytes = (rel: string): Uint8Array => new Uint8Array(readFileSync(new URL(rel, repoRoot)));
const manifest = JSON.parse(readFileSync(new URL('fixtures/manifest.json', repoRoot), 'utf8')) as Manifest;

function load(file: ManifestFile) {
  return parseLocale(readBytes(file.path), {
    fileName: file.path,
    locale: file.locale,
    dialect: file.dialect,
    role: file.role,
  });
}

const contextResult = parseContextFile(readBytes(manifest.context), manifest.context);
const glossaryResult = parseGlossaryFile(readBytes(manifest.glossary), manifest.glossary);
const corpora = [...new Set(manifest.files.map((f) => f.corpus))];

describe('clean metadata imports without errors', () => {
  it('context.json', () => {
    expect(contextResult.rejected).toBe(false);
    expect(contextResult.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(contextResult.context.size).toBeGreaterThan(0);
  });

  it('glossary.json', () => {
    expect(glossaryResult.rejected).toBe(false);
    expect(glossaryResult.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(glossaryResult.glossary.length).toBeGreaterThan(0);
  });
});

describe.each(corpora)('clean corpus %s: zero error-severity findings', (corpus) => {
  const files = manifest.files.filter((f) => f.corpus === corpus);
  const sourceFile = files.find((f) => f.role === 'source');
  if (!sourceFile) throw new Error(`corpus ${corpus} has no source file in the manifest`);
  const targets = files.filter((f) => f.role === 'target');

  it('has at least one target', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it(`source ${sourceFile.path} imports cleanly`, () => {
    const { doc, issues } = load(sourceFile);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(doc.rejected).toBe(false);
    expect(doc.eligible).toEqual({ review: true, export: true });
    expect(doc.entries.size).toBeGreaterThan(0);
  });

  it.each(targets.map((t): [string, ManifestFile] => [t.locale, t]))('%s target has no error findings', async (_locale, target) => {
    const source = load(sourceFile);
    const parsed = load(target);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(parsed.doc.rejected).toBe(false);
    expect(parsed.doc.eligible).toEqual({ review: true, export: true });

    // `await` tolerates either a sync or an async runChecks.
    const findings = await runChecks(source.doc, parsed.doc, {
      context: contextResult.context,
      glossary: glossaryResult.glossary,
    });
    const errors = findings
      .filter((f) => f.severity === 'error')
      .map((f) => `${f.ruleId} ${f.locale} ${JSON.stringify(f.path)}: ${f.message}`);
    expect(errors).toEqual([]);
  });
});
