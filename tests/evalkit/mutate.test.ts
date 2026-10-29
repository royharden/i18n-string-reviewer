import { describe, expect, it } from 'vitest';
import { generateMutations, MUTATION_OPERATORS } from '../../src/core/evalkit/mutate.ts';
import type { MutationCorpus, MutationInput } from '../../src/core/evalkit/mutate.ts';
import { parseLocale } from '../../src/core/l10nchecks/parse.ts';
import { pathKey } from '../../src/core/l10nchecks/paths.ts';
import type { CheckOptions, Dialect, LocaleDocument } from '../../src/core/l10nchecks/types.ts';
import { splitForKey } from '../../src/core/evalkit/split.ts';

// Test-only synthetic strings; no semantic label file or provider output is used for tuning.
function doc(value: unknown, locale: string, dialect: Dialect, role: 'source' | 'target'): LocaleDocument {
  const parsed = parseLocale(new TextEncoder().encode(JSON.stringify(value)), { locale, dialect, role, fileName: `${locale}-${dialect}.json` });
  return parsed.doc;
}

const options: CheckOptions = { glossary: [
  { term: 'TaskBoard', doNotTranslate: true },
  { term: 'card', translations: { ru: 'карточ', ja: 'カード', fr: 'carte' } },
] };

function input(): MutationInput {
  const sourceIcu = {
    greeting: 'Hello {name}', anotherGreeting: 'Welcome {person}', pair: '{first} with {second}', typed: '{n, number}',
    count: '{n, plural, one {# card} other {# cards}}',
    exact: '{n, plural, =0 {No cards} one {# card} other {# cards}}',
    role: '{role, select, admin {Administrator} other {Guest}}', rich: '<b>{name}</b> joined',
    number: 'Archive after 30 days.', grouped: 'Up to 10,000 cards.', glossary: 'Open a card',
    prose: 'The detailed account preferences can be changed here.', brand: 'TaskBoard',
    literalMask: 'Hello ⟦P1⟧',
    'literal.dot': 'A literal dotted key', nested: { key: 'A nested key' },
    ...Object.fromEntries([['__proto__', 'Prototype is ordinary data']]),
  };
  const ru = {
    ...sourceIcu, greeting: 'Привет {name}', anotherGreeting: 'Добро пожаловать {person}', pair: '{first} вместе с {second}', typed: '{n, number}',
    count: '{n, plural, one {# карточка} few {# карточки} many {# карточек} other {# карточки}}',
    exact: '{n, plural, =0 {Нет карточек} one {# карточка} few {# карточки} many {# карточек} other {# карточки}}',
    role: '{role, select, admin {Администратор} other {Гость}}', rich: '<b>{name}</b> присоединился',
    number: 'Архивировать через 30 дней.', grouped: 'Не более 10\u00A0000 карточек.', glossary: 'Открыть карточку',
    prose: 'Здесь доступны настройки.',
    literalMask: 'Привет P1',
  };
  const ja = {
    ...sourceIcu, greeting: 'こんにちは {name}', anotherGreeting: 'ようこそ {person}', pair: '{first} と {second}',
    count: '{n, plural, other {# カード}}', exact: '{n, plural, =0 {カードなし} other {# カード}}',
    role: '{role, select, admin {管理者} other {ゲスト}}', glossary: 'カードを開く', prose: '設定できます。',
    literalMask: 'こんにちは P1',
  };
  const sourceNext = { greeting: 'Hello {{name}}', nesting: 'Open $t(nav.board)', count_one: '{{count}} task', count_other: '{{count}} tasks', brand: 'TaskBoard', nav: { board: 'Board' }, literalMask: 'Hello ⟦P1⟧' };
  const nextRu = { greeting: 'Привет {{name}}', nesting: 'Открыть $t(nav.board)', count_one: '{{count}} задача', count_few: '{{count}} задачи', count_many: '{{count}} задач', count_other: '{{count}} задачи', brand: 'TaskBoard', nav: { board: 'Доска' }, literalMask: 'Привет P1' };
  const nextJa = { greeting: 'こんにちは {{name}}', nesting: '$t(nav.board) を開く', count_other: '{{count}} タスク', brand: 'TaskBoard', nav: { board: 'ボード' }, literalMask: 'こんにちは P1' };
  const plainSource = { mixed: '%s has %d files', indexed: '%1$s of %2$s files', number: 'Wait 30 days.', text: 'Account settings', named: '{name} joins {project}', brand: 'TaskBoard', literalMask: 'Hello ⟦P1⟧' };
  const plainFr = { mixed: '%s a %d fichiers', indexed: '%1$s de %2$s fichiers', number: 'Attendre 30 jours.', text: 'Préférences', named: '{name} rejoint {project}', brand: 'TaskBoard', literalMask: 'Salut P1' };
  const corpora: MutationCorpus[] = [
    { id: 'icu', source: doc(sourceIcu, 'en', 'icu', 'source'), target: doc(ru, 'ru', 'icu', 'target'), options },
    { id: 'icu', source: doc(sourceIcu, 'en', 'icu', 'source'), target: doc(ja, 'ja', 'icu', 'target'), options },
    { id: 'next', source: doc(sourceNext, 'en', 'i18next', 'source'), target: doc(nextRu, 'ru', 'i18next', 'target'), options },
    { id: 'next', source: doc(sourceNext, 'en', 'i18next', 'source'), target: doc(nextJa, 'ja', 'i18next', 'target'), options },
    { id: 'plain', source: doc(plainSource, 'en', 'plain', 'source'), target: doc(plainFr, 'fr', 'plain', 'target'), options },
  ];
  return { corpora, seed: 20261035, split: { dev: 0.6 } };
}

function singlePairInput(source: string, target: string, dialect: Dialect, maxLength?: number): MutationInput {
  return {
    corpora: [{
      id: 'synthetic', source: doc({ sample: source }, 'en', dialect, 'source'), target: doc({ sample: target }, 'fr', dialect, 'target'),
      options: maxLength === undefined ? {} : { context: new Map([[pathKey(['sample']), { maxLength }]]) },
    }],
    seed: 20261035, split: { dev: 0.6 },
  };
}

describe('seeded structural mutations', () => {
  it('is deterministic by seed and independent of corpus input order', () => {
    // what_bug_this_catches: iteration order or Math.random can change planted truth between methods.
    const args = input();
    const first = generateMutations(args);
    expect(generateMutations(args)).toEqual(first);
    expect(generateMutations({ ...args, corpora: [...args.corpora].reverse() })).toEqual(first);
    const reversedEntries = args.corpora.map((corpus) => ({ ...corpus, source: { ...corpus.source, entries: new Map([...corpus.source.entries].reverse()) }, target: { ...corpus.target, entries: new Map([...corpus.target.entries].reverse()) } }));
    expect(generateMutations({ ...args, corpora: reversedEntries })).toEqual(first);
    const chosen = (seed: number): unknown[] => generateMutations({ ...args, seed }).cases.map((item) => [item.label.operator, item.label.key, item.label.before, item.label.after]);
    expect(chosen(20261035)).not.toEqual(chosen(20261036));
  });

  it('implements every declared operator and explains ineligible corpus/locale combinations', () => {
    // what_bug_this_catches: a switch with empty operator cases can report misleading coverage.
    const args = input();
    const generated = generateMutations(args);
    expect(new Set(generated.cases.map((item) => item.label.operator))).toEqual(new Set(MUTATION_OPERATORS));
    expect(generated.coverage).toHaveLength(args.corpora.length * MUTATION_OPERATORS.length);
    for (const row of generated.coverage) {
      if (row.selected === 0) {
        expect(row.candidateCount).toBe(0);
        expect(row.reason?.length).toBeGreaterThan(0);
      } else expect(row.candidateCount).toBeGreaterThan(0);
    }
    const swapped = generated.cases.find((item) => item.label.operator === 'swap_unindexed_printf');
    expect(swapped?.label.expected).toContainEqual({ ruleId: 'placeholder_mismatch', severity: 'error' });
    expect(swapped?.label.after).not.toEqual(swapped?.label.before);
  });

  it('isolates one edit per scenario, retains immutable input, and rebuilds valid value offsets', () => {
    // what_bug_this_catches: interacting planted errors or stale offsets can invalidate scoring/export.
    const args = input();
    const originalTexts = args.corpora.map((corpus) => corpus.target.text);
    const generated = generateMutations(args);
    expect(new Set(generated.cases.map((item) => item.id)).size).toBe(generated.cases.length);
    for (const item of generated.cases) {
      const original = args.corpora.find((corpus) => corpus.id === item.corpus && corpus.target.locale === item.label.locale)!.target;
      const keys = new Set([...original.entries.keys(), ...item.target.entries.keys()]);
      const changed = [...keys].filter((key) => JSON.stringify(original.entries.get(key)?.value) !== JSON.stringify(item.target.entries.get(key)?.value));
      expect(changed, item.label.operator).toHaveLength(item.label.operator === 'do_not_translate_identical' ? 0 : 1);
      expect(item.target.eligible).toEqual({ review: false, export: false });
      expect(() => JSON.parse(item.target.text)).not.toThrow();
      for (const entry of item.target.entries.values()) expect(JSON.parse(item.target.text.slice(entry.offset, entry.offset + entry.length))).toEqual(entry.value);
      if (item.target.entries.has(pathKey(['__proto__']))) expect(Object.hasOwn(JSON.parse(item.target.text), '__proto__')).toBe(true);
    }
    expect(args.corpora.map((corpus) => corpus.target.text)).toEqual(originalTexts);
  });

  it('separates the suffix-family finding path from its deleted-member and split paths', () => {
    // what_bug_this_catches: scoring against the removed _few path makes a correct family diagnostic a miss.
    const generated = generateMutations(input());
    const removed = generated.cases.find((item) => item.label.operator === 'drop_suffix_family_member');
    expect(removed?.sourceKey).toEqual(['count']);
    expect(removed?.label.key).toEqual(['count_other']);
    expect(removed?.target.entries.has(pathKey(['count_other']))).toBe(true);
    const extra = generated.cases.find((item) => item.label.operator === 'add_suffix_family_member');
    expect(extra?.sourceKey).toEqual(['count']);
    expect(extra?.label.key).toEqual(['count_other']);
    expect(extra?.target.entries.has(pathKey(['count_one']))).toBe(true);
  });

  it('filters by canonical source key before selecting and never leaks a family between splits', () => {
    const args = input();
    const dev = generateMutations({ ...args, onlySplit: 'dev' });
    const heldout = generateMutations({ ...args, onlySplit: 'heldout' });
    for (const [split, generated] of [['dev', dev], ['heldout', heldout]] as const) for (const item of generated.cases) {
      expect(item.label.split).toBe(split);
      expect(splitForKey(item.sourceKey, { seed: args.seed, dev: args.split.dev })).toBe(split);
    }
    const devKeys = new Set(dev.cases.map((item) => JSON.stringify(item.sourceKey)));
    expect(heldout.cases.some((item) => devKeys.has(JSON.stringify(item.sourceKey)))).toBe(false);
  });

  it('keeps controls truth-negative and records independently predictable appended length overflow', () => {
    const generated = generateMutations(input());
    const controls = new Set(['reorder_named', 'reorder_indexed_printf', 'regroup_number', 'nbsp_entity', 'drop_hash_in_branch', 'grow_1_4x', 'do_not_translate_identical', 'literal_mask_token']);
    for (const item of generated.cases) {
      if (controls.has(item.label.operator)) expect(item.label.expected).toEqual([]);
      else expect(item.label.expected.length).toBeGreaterThan(0);
    }
    expect(generated.cases.some((item) => item.label.operator === 'inject_instruction' && item.label.expected.some((rule) => rule.ruleId === 'length_risk'))).toBe(true);
  });

  it.each(['icu', 'plain', 'i18next'] as const)('keeps literal mask data numerically matched and within the metadata cap in %s', (dialect) => {
    // what_bug_this_catches: appending P1 plants a new 1 and can turn a negative control into a real length warning.
    const source = 'Hello ⟦P1⟧', before = 'Salut P1', after = 'Salut ⟦P1⟧';
    const args = singlePairInput(source, before, dialect, 10);
    const originalTexts = args.corpora.map((corpus) => [corpus.source.text, corpus.target.text]);
    const control = generateMutations(args).cases.find((item) => item.label.operator === 'literal_mask_token')!;
    expect(control.label).toMatchObject({ key: ['sample'], before, after, expected: [] });
    expect(control.target.entries.get(pathKey(['sample']))?.value).toBe(after);
    // All three are prose, so these literal digits and code points are the independent numeric/length truth.
    expect(source.match(/[0-9]+/gu)).toEqual(['1']);
    expect(before.match(/[0-9]+/gu)).toEqual(['1']);
    expect(after.match(/[0-9]+/gu)).toEqual(['1']);
    expect([...source]).toHaveLength(10);
    expect([...before]).toHaveLength(8);
    expect([...after]).toHaveLength(10);
    expect(after).not.toBe(source);
    expect(control.sourceKey).toEqual(['sample']);
    expect(control.label.split).toBe(splitForKey(['sample'], { seed: args.seed, dev: args.split.dev }));
    expect(args.corpora.map((corpus) => [corpus.source.text, corpus.target.text])).toEqual(originalTexts);
  });

  it('allows a matched literal token exactly at the ratio limit', () => {
    // what_bug_this_catches: rejecting every literal token or treating the strict 1.6x boundary as overflow loses a clean control.
    const source = 'Hello ⟦P1⟧', before = 'SalutEncore P1', after = 'SalutEncore ⟦P1⟧';
    expect([...source]).toHaveLength(10);
    expect([...before]).toHaveLength(14);
    expect([...after]).toHaveLength(16);
    const control = generateMutations(singlePairInput(source, before, 'plain')).cases.find((item) => item.label.operator === 'literal_mask_token')!;
    expect(control.label.after).toBe(after);
    expect(control.label.expected).toEqual([]);
  });

  it.each([
    { name: 'no matched literal/numeric anchor', source: 'Hello', before: 'Salut', maxLength: 15 },
    { name: 'two delimiters cross a metadata cap', source: 'Hello ⟦P1⟧', before: 'Salut P1', maxLength: 9 },
    { name: 'two delimiters cross the ratio limit', source: 'A ⟦P1⟧', before: 'Salutt P1', maxLength: undefined },
    { name: 'wrapping would create an identical translation', source: 'Hello ⟦P1⟧', before: 'Hello P1', maxLength: 10 },
    { name: 'the target already contains the literal token', source: 'Hello ⟦P1⟧', before: 'Salut ⟦P1⟧', maxLength: 10 },
  ])('skips the literal control when $name', ({ source, before, maxLength }) => {
    // what_bug_this_catches: a dirty or impossible negative control must be a precondition skip, never silently clean gold.
    expect(before.match(/[0-9]+/gu)).toEqual(source.match(/[0-9]+/gu));
    expect([...before].length).toBeLessThanOrEqual(maxLength ?? 1.6 * [...source].length);
    const generated = generateMutations(singlePairInput(source, before, 'plain', maxLength));
    expect(generated.cases.some((item) => item.label.operator === 'literal_mask_token')).toBe(false);
    expect(generated.coverage.find((row) => row.operator === 'literal_mask_token')).toMatchObject({ candidateCount: 0, selected: 0, reason: expect.stringContaining('matched prose ending in source " ⟦P1⟧" and target " P1"') });
  });

  it.each([
    { name: 'ICU named argument crosses the cap', dialect: 'icu', source: 'Hello {name}', before: 'Salut {name}', after: 'Salut {name} {name}', beforeWidth: 12, afterWidth: 19, maxLength: 15, overflow: true },
    { name: 'ICU named argument exactly fits the cap', dialect: 'icu', source: 'Hello {name}', before: 'Salut {name}', after: 'Salut {name} {name}', beforeWidth: 12, afterWidth: 19, maxLength: 19, overflow: false },
    { name: 'formatted ICU argument crosses the cap by one', dialect: 'icu', source: 'Count {n, number}', before: 'Total {n, number}', after: 'Total {n, number} {n, number}', beforeWidth: 9, afterWidth: 13, maxLength: 12, overflow: true },
    { name: 'formatted ICU argument fits by its argument width', dialect: 'icu', source: 'Count {n, number}', before: 'Total {n, number}', after: 'Total {n, number} {n, number}', beforeWidth: 9, afterWidth: 13, maxLength: 13, overflow: false },
    { name: 'plain formatted token retains its raw width', dialect: 'plain', source: 'Hi {name:upper}', before: 'Yo {name:upper}', after: 'Yo {name:upper} {name:upper}', beforeWidth: 15, afterWidth: 28, maxLength: 20, overflow: true },
    { name: 'plain indexed printf retains its raw width', dialect: 'plain', source: 'Hi %1$s', before: 'Yo %1$s', after: 'Yo %1$s %1$s', beforeWidth: 7, afterWidth: 12, maxLength: 8, overflow: true },
    { name: 'i18next formatted token retains its raw width', dialect: 'i18next', source: 'Hi {{name, upper}}', before: 'Yo {{name, upper}}', after: 'Yo {{name, upper}} {{name, upper}}', beforeWidth: 18, afterWidth: 34, maxLength: 20, overflow: true },
    { name: 'the metadata cap overrides the ratio', dialect: 'icu', source: 'Hi {name}', before: 'Salut {name}', after: 'Salut {name} {name}', beforeWidth: 12, afterWidth: 19, maxLength: 19, overflow: false },
  ] as const)('labels the full duplicated display width when $name', ({ dialect, source, before, after, beforeWidth, afterWidth, maxLength, overflow }) => {
    // what_bug_this_catches: counting only the appended space omits valid length_risk truth; raw ICU format syntax overcounts it.
    expect(beforeWidth + 1).toBeLessThanOrEqual(maxLength);
    expect(afterWidth > maxLength).toBe(overflow);
    const duplicate = generateMutations(singlePairInput(source, before, dialect, maxLength)).cases.find((item) => item.label.operator === 'duplicate_placeholder')!;
    expect(duplicate.label.before).toBe(before);
    expect(duplicate.label.after).toBe(after);
    expect(duplicate.label.expected).toEqual([
      { ruleId: 'placeholder_mismatch', severity: 'error' },
      ...(overflow ? [{ ruleId: 'length_risk', severity: 'warning' }] : []),
    ]);
  });

  it.each([
    { name: 'exactly at', before: 'Saluts {id}', after: 'Saluts {id} {id}', beforeWidth: 11, afterWidth: 16, overflow: false },
    { name: 'one code point over', before: 'Salutss {id}', after: 'Salutss {id} {id}', beforeWidth: 12, afterWidth: 17, overflow: true },
  ])('labels duplicated placeholders $name the ratio boundary', ({ before, after, beforeWidth, afterWidth, overflow }) => {
    // what_bug_this_catches: the separator alone stays below 1.6x while the token can cross it; equality must remain clean.
    const source = 'Hello {id}';
    expect([...source]).toHaveLength(10);
    expect([...before]).toHaveLength(beforeWidth);
    expect([...after]).toHaveLength(afterWidth);
    expect(beforeWidth + 1).toBeLessThanOrEqual(16);
    expect(afterWidth > 16).toBe(overflow);
    const duplicate = generateMutations(singlePairInput(source, before, 'icu')).cases.find((item) => item.label.operator === 'duplicate_placeholder')!;
    expect(duplicate.label.after).toBe(after);
    expect(duplicate.label.expected).toEqual([
      { ruleId: 'placeholder_mismatch', severity: 'error' },
      ...(overflow ? [{ ruleId: 'length_risk', severity: 'warning' }] : []),
    ]);
  });

  it('rejects invalid seeds, fractions, duplicate corpus identities and ineligible input', () => {
    const args = input();
    expect(() => generateMutations({ ...args, seed: NaN })).toThrow();
    expect(() => generateMutations({ ...args, split: { dev: 1 } })).toThrow();
    expect(() => generateMutations({ ...args, corpora: [args.corpora[0]!, args.corpora[0]!] })).toThrow();
    const corpus = args.corpora[0]!;
    expect(() => generateMutations({ ...args, corpora: [{ ...corpus, target: { ...corpus.target, eligible: { review: false, export: false } } }] })).toThrow();
  });
});
