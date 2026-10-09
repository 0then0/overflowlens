import { type Calculation, fail, type Rational } from './types';
export function thresholdPercent(text: string): Rational {
  if (text.length > 102 || !/^\d+(?:\.\d+)?$/.test(text))
    fail(
      'INVALID_THRESHOLD',
      'Enter a decimal percentage from 0 to 100, using a dot and at most 100 digits.',
    );
  const [whole, fraction = ''] = text.split('.');
  const numerator = BigInt(whole + fraction),
    denominator = 100n * 10n ** BigInt(fraction.length);
  if (numerator > denominator)
    fail('INVALID_THRESHOLD', 'The maximum error percentage must be between 0 and 100.');
  return { numerator, denominator };
}
export function compare(a: Rational, b: Rational): bigint {
  return a.numerator * b.denominator - b.numerator * a.denominator;
}
export function calculate(K: bigint, E: bigint, O: bigint, threshold: Rational): Calculation {
  if (K < 0n || E < 0n || O < 0n || E > K)
    fail('INVALID_COUNTS', 'Counts must be nonnegative with E ≤ K.');
  if (
    threshold.denominator <= 0n ||
    threshold.numerator < 0n ||
    threshold.numerator > threshold.denominator
  )
    fail('INVALID_THRESHOLD', 'Threshold must be in [0, 1].');
  const T = K + O;
  if (T === 0n) return { K, E, O, T, threshold, status: 'NO_DATA', lower: null, upper: null };
  const lower = { numerator: E, denominator: T },
    upper = { numerator: E + O, denominator: T };
  const status =
    compare(upper, threshold) <= 0n
      ? 'WITHIN_LIMIT'
      : compare(lower, threshold) > 0n
        ? 'EXCEEDS_LIMIT'
        : 'INDETERMINATE';
  return { K, E, O, T, threshold, status, lower, upper };
}
export function formatPercent(value: Rational): string {
  const scale = 1_000_000n,
    scaled = (value.numerator * 100n * scale) / value.denominator;
  const remainder = (value.numerator * 100n * scale) % value.denominator;
  if (scaled === 0n && value.numerator > 0n) return '<0.000001%';
  const whole = scaled / scale,
    tail = (scaled % scale).toString().padStart(6, '0').replace(/0+$/, '');
  return `${remainder ? '≈' : ''}${whole}${tail ? `.${tail}` : ''}%`;
}
// For visual position only; never used for a verdict or exact labels.
export function scalePercent(value: Rational): number {
  return Number((value.numerator * 100_000n) / value.denominator) / 1000;
}
