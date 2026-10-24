import { describe, expect, it } from 'vitest';
import { wilson95 } from '../../src/core/evalkit/wilson.ts';

describe('Wilson 95% intervals', () => {
  it.each([
    [0, 10, 0, 0.2775327998628892],
    [10, 10, 0.7224672001371107, 1],
    [5, 10, 0.236593090512564, 0.763406909487436],
    [1, 1, 0.20654931437723745, 1],
    [50, 100, 0.4038315303659956, 0.5961684696340044],
  ])('matches independent tabulated values for %i/%i', (successes, total, lower, upper) => {
    // what_bug_this_catches: a Wald interval reports false certainty for tiny or all-success samples.
    const interval = wilson95(successes, total);
    expect(interval?.lower).toBeCloseTo(lower, 10);
    expect(interval?.upper).toBeCloseTo(upper, 10);
  });

  it('returns N/A rather than a numeric confidence interval without observations', () => {
    // what_bug_this_catches: an unexecuted provider row must not look like perfect precision.
    expect(wilson95(0, 0)).toBeNull();
  });

  it.each([[1, 0], [-1, 10], [11, 10], [0.5, 10], [1, -1], [1, Infinity], [NaN, 1]])('rejects invalid count pair %s/%s', (successes, total) => {
    expect(() => wilson95(successes, total)).toThrow(RangeError);
  });
});
