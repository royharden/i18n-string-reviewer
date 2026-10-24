// Recomputes the dev / held-out split for every semantic label from its source key path and the
// manifest seed, and rewrites the `split` field in fixtures/labels/semantic.jsonl.
//
//   tsx scripts/make-split.ts            rewrite labels in place (only the `split` field changes)
//   tsx scripts/make-split.ts --check    exit 1 if any stored split differs; writes nothing
//
// The split is a pure function of (key path, seed) — see src/core/evalkit/split.ts. Locale never
// enters it, so every locale of a key (and every label on that key) lands in the same split.
// The held-out split was frozen on manifest.heldoutFrozenAt; changing the seed, the rule, the
// corpus keys or the labels after the first held-out run requires a new `heldout-v2` manifest.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { splitForKey, type Split, type SplitConfig } from '../src/core/evalkit/split.ts';

interface Manifest {
  seed: number | string;
  split: { by: string; dev: number; heldout: number };
  files: Array<{ path: string; locale: string; dialect: string; role: string; corpus: string }>;
  labels: { semantic: string };
}

interface Label {
  id: string;
  key: string[];
  locale: string;
  split?: Split;
  [field: string]: unknown;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const checkOnly = process.argv.includes('--check');

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as T;
}

function leafPaths(node: unknown, prefix: string[] = [], out: string[][] = []): string[][] {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) leafPaths(v, [...prefix, k], out);
  } else {
    out.push(prefix);
  }
  return out;
}

const manifest = readJson<Manifest>('fixtures/manifest.json');
if (manifest.split.by !== 'source_key') throw new Error(`unsupported split.by: ${manifest.split.by}`);
const config: SplitConfig = { seed: manifest.seed, dev: manifest.split.dev };

// Source keys of the main ICU corpus: labels must point at one of them.
const sourceFile = manifest.files.find((f) => f.role === 'source' && f.corpus === 'taskboard-icu');
if (!sourceFile) throw new Error('manifest has no taskboard-icu source file');
const sourceKeys = new Set(leafPaths(readJson<unknown>(sourceFile.path)).map((p) => JSON.stringify(p)));

const labelsPath = join(root, manifest.labels.semantic);
const lines = readFileSync(labelsPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
let changed = 0;
const counts = { dev: 0, heldout: 0 };
const out: string[] = [];
for (const [i, line] of lines.entries()) {
  const label = JSON.parse(line) as Label;
  if (!Array.isArray(label.key) || !sourceKeys.has(JSON.stringify(label.key))) {
    throw new Error(`line ${i + 1} (${label.id}): key ${JSON.stringify(label.key)} is not a source key`);
  }
  const split = splitForKey(label.key, config);
  if (label.split !== split) changed++;
  counts[split]++;
  // Rebuild with `split` kept as the last field so diffs stay one-field-wide.
  const { split: _old, ...rest } = label;
  out.push(JSON.stringify({ ...rest, split }));
}

const corpusCounts = { dev: 0, heldout: 0 };
for (const k of sourceKeys) corpusCounts[splitForKey(JSON.parse(k) as string[], config)]++;

console.log(
  `labels: ${lines.length} (dev ${counts.dev}, heldout ${counts.heldout}); ` +
    `source keys: ${sourceKeys.size} (dev ${corpusCounts.dev}, heldout ${corpusCounts.heldout}); ` +
    `split fields ${checkOnly ? 'differing' : 'rewritten'}: ${changed}`,
);

if (checkOnly) {
  process.exit(changed === 0 ? 0 : 1);
} else if (changed > 0) {
  const tmp = `${labelsPath}.tmp`;
  writeFileSync(tmp, `${out.join('\n')}\n`, 'utf8');
  renameSync(tmp, labelsPath);
}
