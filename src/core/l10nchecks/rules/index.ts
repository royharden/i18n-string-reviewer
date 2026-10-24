// Registry of all 17 deterministic rules (PLAN §1.1 item 2). Order: errors, then warnings.

import type { Rule } from '../pairs.ts';
import { ERROR_RULE_IDS, WARNING_RULE_IDS } from '../types.ts';
import type { RuleId } from '../types.ts';
import { rule as bidiControlChars } from './bidi_control_chars.ts';
import { rule as emptyTranslation } from './empty_translation.ts';
import { rule as glossaryViolation } from './glossary_violation.ts';
import { rule as htmlTagMismatch } from './html_tag_mismatch.ts';
import { rule as icuSyntaxInvalid } from './icu_syntax_invalid.ts';
import { rule as injectionLikeText } from './injection_like_text.ts';
import { rule as lengthRisk } from './length_risk.ts';
import { rule as missingKey } from './missing_key.ts';
import { rule as numberDrift } from './number_drift.ts';
import { rule as orphanKey } from './orphan_key.ts';
import { rule as placeholderMismatch } from './placeholder_mismatch.ts';
import { rule as pluralCategoryExtra } from './plural_category_extra.ts';
import { rule as pluralCategoryMissing } from './plural_category_missing.ts';
import { rule as selectBranchMismatch } from './select_branch_mismatch.ts';
import { rule as typeMismatch } from './type_mismatch.ts';
import { rule as untranslatedIdentical } from './untranslated_identical.ts';
import { rule as whitespaceDrift } from './whitespace_drift.ts';

export const RULES: readonly Rule[] = [
  missingKey,
  emptyTranslation,
  typeMismatch,
  placeholderMismatch,
  icuSyntaxInvalid,
  pluralCategoryMissing,
  selectBranchMismatch,
  htmlTagMismatch,
  orphanKey,
  untranslatedIdentical,
  pluralCategoryExtra,
  numberDrift,
  lengthRisk,
  whitespaceDrift,
  bidiControlChars,
  glossaryViolation,
  injectionLikeText,
];

export const RULE_IDS: readonly RuleId[] = [...ERROR_RULE_IDS, ...WARNING_RULE_IDS];

export const RULES_BY_ID: ReadonlyMap<RuleId, Rule> = new Map(RULES.map((r) => [r.id, r]));
