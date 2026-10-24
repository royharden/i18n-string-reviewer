// Mock-only runner. File IO belongs here; core remains platform-neutral. No env or network.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockReviewer, parseReplyFile } from '../src/core/review/mock.ts';
import { demoManifestSchema, loadBrokenDemo, loadDemoSet, runPipeline, summarizePipeline } from '../src/core/review/pipeline.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string): Uint8Array => readFileSync(resolve(root, path));
const json = (path: string): unknown => JSON.parse(new TextDecoder().decode(read(path)));
const manifest = demoManifestSchema.parse(json('fixtures/demo/manifest.json'));
const output: string[] = [];
for (const set of manifest.sets) {
  const imported = loadDemoSet(manifest, set.id, read);
  const replies = set.replies.map((path) => parseReplyFile(json(path), path));
  const result = await runPipeline(imported, { reviewer: createMockReviewer(replies, { set: set.id }) });
  output.push(`[${set.id}]`, summarizePipeline(result));
}
const broken = loadBrokenDemo(manifest, read);
output.push('[broken import]', JSON.stringify(broken.report, null, 2));
const summary = output.join('\n') + '\n';
console.log(summary);
if (process.argv.includes('--write')) {
  const dir = resolve(root, 'demo-output');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'summary.txt'), summary, 'utf8');
}
