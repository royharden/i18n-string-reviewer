// Shared fixture enumeration. Every .json reply file and every regeneration is included.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathKey } from '../../src/core/l10nchecks/paths.ts';
import { maskItem } from '../../src/core/maskgate/mask.ts';
import { matchGlossary, selectSiblings } from '../../src/core/context/pack.ts';
import { resolveSourceText } from '../../src/core/export/patch.ts';
import { parseReplyFile } from '../../src/core/review/mock.ts';
import type { Reply, ReplyFinding } from '../../src/core/review/mock.ts';
import { demoManifestSchema, loadDemoSet } from '../../src/core/review/pipeline.ts';
import type { ReviewItemRecord } from '../../src/core/review/pipeline.ts';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const read = (path: string): Uint8Array => readFileSync(resolve(root, path));
export const json = (path: string): unknown => JSON.parse(new TextDecoder().decode(read(path)));
export const manifest = demoManifestSchema.parse(json('fixtures/demo/manifest.json'));
export interface ReplyCase { readonly file: string; readonly reply: Reply; readonly record: ReviewItemRecord }
export function loadReplyCases(): ReplyCase[] {
  const imports = new Map(manifest.sets.map((s) => [s.id, loadDemoSet(manifest, s.id, read)]));
  const out: ReplyCase[] = [];
  const names = readdirSync(resolve(root, 'fixtures/replies')).filter((n) => n.endsWith('.json')).sort();
  for (const name of names) {
    const file = parseReplyFile(json(`fixtures/replies/${name}`), name);
    for (const reply of file.replies) {
      let source: string; let target: string; let sourceLocale: string;
      let dialect: 'icu' | 'i18next' | 'plain'; let maxLength: number | undefined;
      const imported = imports.get(file.set);
      const doc = imported?.targets.find((d) => d.locale === reply.locale);
      const context = imported?.context.get(pathKey(reply.key));
      if (reply.item) {
        ({ source, target, sourceLocale, dialect, maxLength } = reply.item);
      } else {
        if (!imported || !doc) throw new Error(`unbound reply ${name}/${reply.id}`);
        const value = doc.entries.get(pathKey(reply.key));
        const src = resolveSourceText(imported.source, reply.key);
        if (value?.kind !== 'string' || src === undefined) throw new Error(`missing fixture item ${reply.id}`);
        source = src; target = value.value as string; sourceLocale = imported.source.locale; dialect = doc.dialect; maxLength = context?.maxLength;
      }
      const itemId = `fixture-${reply.id}`;
      const mask = maskItem({ itemId, path: reply.key, locale: reply.locale, sourceLocale, dialect, source, target,
        ...(context !== undefined ? { context } : maxLength !== undefined ? { context: { maxLength } } : {}),
        ...(imported && doc && !reply.item ? { glossary: matchGlossary(source, imported.glossary), siblings: selectSiblings(imported.source, doc, reply.key) } : {}) });
      out.push({ file: name, reply, record: { itemId, fileName: doc?.fileName ?? 'synthetic.json', key: reply.key, locale: reply.locale, dialect, sourceText: source, targetText: target, mask, ...(maxLength !== undefined ? { maxLength } : {}) } });
    }
  }
  return out;
}
export function allFindings(reply: Reply): readonly ReplyFinding[] { return [...reply.findings, ...(reply.regenerate ?? [])]; }
