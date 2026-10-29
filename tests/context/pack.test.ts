import { expect, it } from 'vitest';
import { buildContextPack, packSections, safeCut } from '../../src/core/context/pack.ts';
import type { PackInput } from '../../src/core/context/pack.ts';
const base: PackInput = { sourceLocale: 'en', locale: 'fr', source: 'Post', pluralCategories: ['one', 'many', 'other'], screen: 'Feed', note: 'Noun heading', description: 'A published message', glossary: ['Post => Publication'], siblings: [{ key: 'feed.button', source: 'Post', target: 'Publier' }] };
it('keeps the fixed priority order and is deterministic on a worst-case fixture', () => {
  const huge = { ...base, note: 'N'.repeat(10000), description: 'D'.repeat(10000), glossary: Array(100).fill('G'.repeat(500)), siblings: Array(100).fill({ key: 'key', source: 'S'.repeat(1000), target: 'T'.repeat(1000) }) };
  const pack = buildContextPack(huge);
  expect(pack.length).toBeLessThanOrEqual(2000); expect(pack).toBe(buildContextPack(huge));
  expect(packSections(pack)).toEqual(['source', 'locale', 'context']);
  expect(pack).not.toContain('Nearby strings:');
});
it('drops siblings before glossary, then lower-priority descriptions when context fills the cap', () => {
  expect(packSections(buildContextPack(base))).toEqual(['source', 'locale', 'context', 'description', 'glossary', 'siblings']);
  const noSiblings = buildContextPack({ ...base, siblings: [{ key: 'huge', source: 'S'.repeat(3000), target: '' }] });
  expect(noSiblings).toContain('Glossary:'); expect(noSiblings).not.toContain('Nearby strings:');
});
it('never splits surrogate pairs or masked tokens at truncation', () => {
  expect(safeCut('A😀B', 2)).toBe('A'); expect(safeCut('A⟦P123⟧B', 4)).toBe('A');
  const p = buildContextPack({ ...base, source: 'S'.repeat(1990) + '⟦P123⟧' });
  expect(p.length).toBeLessThanOrEqual(2000); expect(p).not.toMatch(/⟦[^⟧]*$/u);
});
