// BCP-47 locale handling. A locale that `Intl.PluralRules` does not support is an import error:
// there is no silent fallback to another locale's plural rules (PLAN §1.1).

export type LocaleValidation =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly code: 'invalid_locale' | 'unsupported_locale'; readonly message: string };

export function validateLocale(tag: string): LocaleValidation {
  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'invalid_locale', message: 'locale is empty' };
  }
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(trimmed)[0];
  } catch {
    canonical = undefined;
  }
  if (canonical === undefined) {
    return { ok: false, code: 'invalid_locale', message: `"${trimmed}" is not a well-formed BCP-47 tag` };
  }
  // `lookup` matching: the tag or a truncation of it must be in the runtime's plural data.
  const supported = Intl.PluralRules.supportedLocalesOf([canonical], { localeMatcher: 'lookup' });
  if (supported.length === 0) {
    return {
      ok: false,
      code: 'unsupported_locale',
      message: `"${canonical}" has no plural rules in this runtime (Intl.PluralRules); pick a supported locale`,
    };
  }
  return { ok: true, canonical };
}

const LOCALE_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

/**
 * Suggest a locale from a file name such as `fr.json`, `pt_BR.json`, `messages.ja.json` or
 * `locales/ru/common.json`. A suggestion only: the user confirms (PLAN §1.1).
 */
export function suggestLocaleFromFileName(fileName: string): string | null {
  const parts = fileName.replace(/\\/gu, '/').split('/').filter((p) => p.length > 0);
  const base = parts.pop() ?? '';
  const stem = base.replace(/\.[^.]*$/u, '');
  const candidates: string[] = [];
  const dotted = stem.split('.');
  for (let i = dotted.length - 1; i >= 0; i--) {
    const piece = dotted[i];
    if (piece !== undefined) candidates.push(piece);
  }
  candidates.push(stem);
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = parts[i];
    if (dir !== undefined) candidates.push(dir);
  }
  for (const raw of candidates) {
    const candidate = raw.replace(/_/gu, '-');
    if (!LOCALE_SHAPE.test(candidate)) continue;
    const result = validateLocale(candidate);
    if (result.ok) return result.canonical;
  }
  return null;
}

/** Language subtag of a canonical tag (`pt-BR` → `pt`). */
export function languageOf(locale: string): string {
  const dash = locale.indexOf('-');
  return dash === -1 ? locale : locale.slice(0, dash);
}
