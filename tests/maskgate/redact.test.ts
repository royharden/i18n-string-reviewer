import { expect, it } from 'vitest';
import { maskItem } from '../../src/core/maskgate/mask.ts';
import { findSecretSpans, redactText } from '../../src/core/shared/redact.ts';

const secret = 'synthetic.person@example.invalid';
it('redacts all model-visible fields, with secret-free legends and restore maps', () => {
  const m = maskItem({ itemId: 'x', path: [secret], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: `Hello ${secret}`, target: `Bonjour ${secret}`, context: { screen: secret, note: secret, description: secret }, glossary: [{ term: secret, translations: { fr: secret }, note: secret }], siblings: [{ path: [secret], source: secret, target: secret }] });
  expect(JSON.stringify(m.masked)).not.toContain(secret);
  expect(JSON.stringify(m.legend)).not.toContain(secret);
  for (const restore of m.restores) {
    expect(restore.original).not.toContain(secret);
    for (const [token, value] of restore.tokens) {
      expect(token).not.toMatch(/⟦R\d+⟧/u); expect(value).not.toContain(secret);
    }
  }
  const tokens = JSON.stringify(m.masked).match(/⟦R\d+⟧/gu) ?? [];
  expect(new Set(tokens).size).toBeGreaterThanOrEqual(12);
  expect(m.fixAllowed).toBe(false);
});
it('each repeated secret receives its own index, without rescanning emitted tokens', () => {
  const m = maskItem({ itemId: 'x', path: ['key'], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: `${secret} ${secret}`, target: 'Bonjour' });
  expect(m.masked.source).toBe('⟦R1⟧ ⟦R2⟧'); expect(m.secretCount).toBe(2);
});
it('a redacted note alone disables fixes', () => {
  const m = maskItem({ itemId: 'x', path: ['key'], locale: 'fr', sourceLocale: 'en', dialect: 'plain', source: 'Hello', target: 'Bonjour', context: { note: secret } });
  expect(m.notAllowed).toEqual(['fix_not_allowed_redacted']);
});
it.each([
  'sk-ant-syntheticCredential1234567890', 'sk-syntheticCredential1234567890', 'ghp_syntheticCredential1234567890',
  'xoxb-synthetic-credential-1234567890', 'AKIA1234567890ABCDEF', 'eyJabcdefghijk.abcdefghijk.abcdefghijk',
  '-----BEGIN PRIVATE KEY-----synthetic-----END PRIVATE KEY-----', 'https://user:password@example.invalid/path',
  secret, '0123456789abcdef0123456789abcdef', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', 'https://user@example.invalid/path',
])('detects synthetic secret shape %s', (value) => {
  expect(findSecretSpans(value).length).toBeGreaterThan(0);
  expect(redactText(value).text).not.toContain(value);
});
