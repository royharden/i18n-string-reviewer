// SOURCE ONLY in Dirty Mode. Exact generated copy parity, not runtime/deployment acceptance.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src', 'core', 'shared');
const destination = join(root, 'supabase', 'functions', 'review-strings', '_shared');
const header = '// GENERATED from src/core/shared/ by scripts/sync-function-shared.ts. DO NOT EDIT.\n';
describe('function shared sources', () => {
  it('copies exactly every shared module, header apart, without nonrelative imports', () => {
    const names = readdirSync(source).filter((n) => n.endsWith('.ts')).sort();
    expect(readdirSync(destination).filter((n) => n.endsWith('.ts')).sort()).toEqual(names);
    for (const name of names) {
      const original = readFileSync(join(source, name), 'utf8');
      const copy = readFileSync(join(destination, name), 'utf8');
      expect(copy.startsWith(header), name).toBe(true);
      expect(copy.slice(header.length), name).toBe(original);
      expect(original, name).not.toMatch(/\bfrom\s+['"](?!\.\/)[^'"]+['"]/u);
      expect(original, name).not.toMatch(/\bimport\s*\(/u);
    }
  });
});
