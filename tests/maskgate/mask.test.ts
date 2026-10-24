import { expect, it } from 'vitest';
import { maskItem, maskText, unmask } from '../../src/core/maskgate/mask.ts';
import { parseLocale } from '../../src/core/l10nchecks/parse.ts';
import { json, read } from './replies.ts';

it('round-trips every clean corpus string in its pinned dialect', () => {
  const manifest = json('fixtures/manifest.json') as { files: Array<{path: string; locale: string; dialect: 'icu' | 'i18next'; role: 'source' | 'target'}> };
  let count = 0;
  for (const f of manifest.files) {
    const doc = parseLocale(read(f.path), { fileName: f.path, locale: f.locale, dialect: f.dialect, role: f.role }).doc;
    for (const e of doc.entries.values()) if (e.kind === 'string') {
      count++;
      const m = maskText(e.value as string, { dialect: f.dialect });
      expect(m.secrets, `${f.path}/${e.path.join('.')}`).toBe(0);
      expect(unmask(m.masked, m.restore)).toEqual({ ok: true, text: e.value });
    }
  }
  expect(count).toBeGreaterThan(500);
});
it('round-trips literal P tokens without interpreting them as generated placeholders', () => {
  const m = maskText('Literal ⟦P1⟧ and {name}', { dialect: 'plain' });
  expect(m.masked).toBe('Literal ⟦L1⟧P1⟦L2⟧ and ⟦P1⟧');
  expect(unmask(m.masked, m.restore)).toEqual({ ok: true, text: 'Literal ⟦P1⟧ and {name}' });
});
it('literal R token plus a real secret: literal restores, secret never enters restore or legend', () => {
  const secret = 'synthetic.person@example.invalid';
  const m = maskItem({ itemId: 'x', path: ['key'], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: 'Hello', target: `Literal ⟦R1⟧ ${secret}` });
  expect(m.fixAllowed).toBe(false); expect(m.notAllowed).toContain('fix_not_allowed_redacted');
  expect(m.restore.original).toBe('');
  expect([...m.restore.tokens.values()].join('')).not.toContain(secret);
  expect(JSON.stringify(m.legend)).not.toContain(secret);
  const restoredLiteral = unmask('⟦L1⟧R1⟦L2⟧', m.restore);
  expect(restoredLiteral).toEqual({ ok: true, text: '⟦R1⟧' });
  expect(unmask(m.masked.target, m.restore).ok).toBe(false);
});
