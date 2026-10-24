// Wilson score intervals for binomial precision and recall. No interval is claimed for F1.
export interface WilsonInterval {
  readonly lower: number;
  readonly upper: number;
}

export const NORMAL_975 = 1.959963984540054;

/** Zero observations are unknown, rather than a perfect or a zero rate. */
export function wilson95(successes: number, total: number): WilsonInterval | null {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(successes) || total < 0 || successes < 0 || successes > total) {
    throw new RangeError('wilson95: counts must be safe integers with 0 <= successes <= total');
  }
  if (total === 0) return null;
  const p = successes / total;
  const z2 = NORMAL_975 * NORMAL_975;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const half = (NORMAL_975 * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}
