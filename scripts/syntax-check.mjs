// Static syntax check for .ts files: strip types (Node 24 built-in), then parse as ESM via `node --check`.
// No execution of application code. Usage: node tscheck.mjs <root>
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = process.argv[2];
const out = mkdtempSync(join(tmpdir(), 's34ts-'));
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { if (n === 'node_modules' || n === '.git') continue; const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(ts|mts)$/.test(n) && !n.endsWith('.d.ts') && files.push(p); } })(root);
let bad = 0, i = 0;
for (const f of files) {
  const rel = relative(root, f);
  try {
    const js = stripTypeScriptTypes(readFileSync(f, 'utf8'), { mode: 'transform' });
    const tmp = join(out, `${i++}.mjs`); writeFileSync(tmp, js);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; console.log(`FAIL ${rel}\n${r.stderr.split('\n').slice(0, 5).join('\n')}`); }
  } catch (e) { bad++; console.log(`FAIL ${rel}: ${e.message.split('\n')[0]}`); }
}
console.log(`checked ${files.length} .ts files, ${bad} failed (.tsx not covered)`);
process.exit(bad ? 1 : 0);
