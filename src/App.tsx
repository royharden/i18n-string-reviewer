import { checkVersion } from './core/l10nchecks/runChecks.ts';
import { RULE_IDS } from './core/l10nchecks/rules/index.ts';

// Placeholder shell (M1). The review UI — import report, findings, evidence, diffs, gate
// rejections, approve/reject/skip and downloads — arrives in M3. Text nodes only.
export function App() {
  return (
    <main>
      <h1>i18n String Reviewer</h1>
      <p>Mock mode — live review not configured.</p>
      <p>
        Scaffold only: the deterministic checks ({RULE_IDS.length} rules, {checkVersion}) exist as a library; the review
        interface is not built yet.
      </p>
    </main>
  );
}
