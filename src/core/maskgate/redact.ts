// Re-export: redaction lives in src/core/shared/redact.ts so the edge function can copy it (PLAN §2.3).
export { REDACTION_MARK, SECRET_PATTERNS, containsSecret, findSecretSpans, redactText } from '../shared/redact.ts';
export type { RedactResult, SecretKind, SecretSpan } from '../shared/redact.ts';
