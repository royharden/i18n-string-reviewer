// Explicit source generator; never imported by the application or deployment entrypoint.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export const GENERATED_HEADER = '// GENERATED from src/core/shared/ by scripts/sync-function-shared.ts. DO NOT EDIT.\n';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src', 'core', 'shared');
const destination = join(root, 'supabase', 'functions', 'review-strings', '_shared');
await mkdir(destination, { recursive: true });
for (const name of (await readdir(source)).filter((n) => n.endsWith('.ts')).sort()) {
  const text = await readFile(join(source, name), 'utf8');
  // Only sibling-relative imports are deployable in this flat generated shared directory.
  if (/\bfrom\s+['"](?!\.\/)[^'"]+['"]/u.test(text) || /\bimport\s*\(/u.test(text)) throw new Error(`nondeployable shared import: ${name}`);
  const path = join(destination, name); const next = GENERATED_HEADER + text;
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === next) continue;
    // No previous generation is destroyed; backups stay outside the product repository.
    const backups = join(root, '..', 'agentops', 'backups', 'function-shared');
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, `${name}.${Date.now()}.${crypto.randomUUID()}.bak`), existing, { flag: 'wx' });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(path, next);
}
