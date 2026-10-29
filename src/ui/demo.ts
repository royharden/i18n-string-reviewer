import { createMockReviewer, parseReplyFile } from '../core/review/mock.ts';
import { demoManifestSchema, loadBrokenDemo, loadDemoSet } from '../core/review/pipeline.ts';
import type { DemoManifest, ImportInput, ImportResult } from '../core/review/pipeline.ts';
import type { Reviewer } from '../core/review/types.ts';

// Only the authored dev demo and recorded replies enter the browser bundle. Held-out corpus is excluded.
const files = import.meta.glob<string>(['../../fixtures/demo/**/*.json', '../../fixtures/replies/*.json'], { query: '?raw', import: 'default', eager: true });

function raw(path: string): string {
  const text = files[`../../${path}`];
  if (text === undefined) throw new Error(`Demo asset is unavailable: ${path}`);
  return text;
}

export function readDemoManifest(): DemoManifest {
  return demoManifestSchema.parse(JSON.parse(raw('fixtures/demo/manifest.json')) as unknown);
}

export function demoImport(setId: string, broken: boolean): { input: ImportInput; imported: ImportResult; reviewer: Reviewer; description: string } {
  const manifest = readDemoManifest();
  const set = manifest.sets.find((entry) => entry.id === (broken ? manifest.broken.set : setId));
  if (!set) throw new Error('The selected demo set is unavailable.');
  const read = (path: string): Uint8Array => new TextEncoder().encode(raw(path));
  const file = (ref: DemoManifest['sets'][number]['source']) => ({ fileName: ref.path.split('/').pop() ?? ref.path, bytes: read(ref.path), locale: ref.locale, dialect: ref.dialect });
  const input: ImportInput = {
    source: file(set.source), targets: (broken ? [manifest.broken.file] : set.targets).map(file),
    ...(set.context ? { context: { fileName: 'context.json', bytes: read(set.context) } } : {}),
    ...(set.glossary ? { glossary: { fileName: 'glossary.json', bytes: read(set.glossary) } } : {}),
  };
  const replies = set.replies.map((path) => parseReplyFile(JSON.parse(raw(path)) as unknown, path));
  return { input, imported: broken ? loadBrokenDemo(manifest, read) : loadDemoSet(manifest, set.id, read), reviewer: createMockReviewer(replies, { set: set.id }), description: broken ? manifest.broken.note : set.label };
}
