import { compare } from './calculate';
import { array, double, integer, object } from './parse';
import { fail, type ObjectValue, type Rational } from './types';

// Wire validation and threshold classification of one ExponentialHistogramDataPoint,
// following the OpenTelemetry metrics data model and the OTLP metrics proto.
//
// Bucket `index` of the positive range holds values v with base^index < v <= base^(index+1),
// base = 2^(2^-scale): lower bounds are exclusive, upper bounds inclusive. Array element i
// of `bucketCounts` is the bucket `offset + i`. The zero bucket holds values with
// |v| <= zeroThreshold; with zeroThreshold 0 it holds zero and values too small for the
// exponential formula. count = zeroCount + positive + negative bucket counts.

// The data model recommends a maximum scale of 20; at -10 two buckets span every double.
export const MIN_SCALE = -10;
export const MAX_SCALE = 20;
// Per range. The SDK default is 160; the limit only keeps one point bounded.
export const MAX_EXPONENTIAL_BUCKETS = 16_384;
const INT32_MAX = 2 ** 31 - 1;

export type ExponentialBuckets = { offset: number; bucketCounts: bigint[] };
export type ExponentialRead = {
  count: bigint;
  scale: number;
  zeroCount: bigint;
  zeroThreshold: number;
  positive: ExponentialBuckets;
  negative: ExponentialBuckets;
};

// The exponent of base^index as an exact fraction of safe integers: index / 2^scale.
function exponent(index: number, scale: number) {
  return scale >= 0 ? { num: index, den: 2 ** scale } : { num: index * 2 ** -scale, den: 1 };
}

function readBuckets(raw: unknown, scale: number, path: string): ExponentialBuckets {
  if (raw === undefined || raw === null) return { offset: 0, bucketCounts: [] };
  const b = object(raw, path);
  // proto3 JSON omits a zero offset.
  const offset = b.offset == null ? 0 : Number(integer(b.offset, `${path}.offset`, false, 32));
  const values = array(b.bucketCounts, `${path}.bucketCounts`);
  if (values.length > MAX_EXPONENTIAL_BUCKETS)
    fail(
      'TOO_MANY_BUCKETS',
      `A bucket range has ${values.length} buckets; at most ${MAX_EXPONENTIAL_BUCKETS} per range are supported.`,
      path,
      'UNSUPPORTED_INPUT',
    );
  const bucketCounts = values.map((v, i) => integer(v, `${path}.bucketCounts[${i}]`, true));
  if (bucketCounts.length > 0 && offset + bucketCounts.length - 1 > INT32_MAX)
    fail(
      'INVALID_BUCKET_INDEX',
      'Bucket indexes must stay within the signed 32-bit range.',
      `${path}.offset`,
    );
  // A non-empty bucket must be able to hold a finite double: its upper bound must reach the
  // smallest subnormal 2^-1074, and its exclusive lower bound must stay below 2^1024.
  for (const [i, c] of bucketCounts.entries()) {
    if (c === 0n) continue;
    const lower = exponent(offset + i, scale);
    const upper = exponent(offset + i + 1, scale);
    if (lower.num >= 1024 * lower.den || upper.num < -1074 * upper.den)
      fail(
        'INVALID_BUCKET_INDEX',
        `Bucket index ${offset + i} at scale ${scale} cannot contain a finite double value.`,
        `${path}.bucketCounts[${i}]`,
      );
  }
  return { offset, bucketCounts };
}

export function readExponentialPoint(p: ObjectValue, path: string): ExponentialRead {
  if (p.flags != null && integer(p.flags, `${path}.flags`, true, 32) !== 0n)
    fail(
      'UNSUPPORTED_FLAGS',
      'Points flagged as missing observations or with unknown flags cannot be counted.',
      path,
      'UNSUPPORTED_INPUT',
    );
  // proto3 JSON encoders omit zero values.
  const count = p.count == null ? 0n : integer(p.count, `${path}.count`, true);
  const scale = p.scale == null ? 0 : Number(integer(p.scale, `${path}.scale`, false, 32));
  if (scale < MIN_SCALE || scale > MAX_SCALE)
    fail(
      'UNSUPPORTED_SCALE',
      `Scale ${scale} is outside the supported range ${MIN_SCALE} to ${MAX_SCALE}.`,
      `${path}.scale`,
      'UNSUPPORTED_INPUT',
    );
  const zeroCount = p.zeroCount == null ? 0n : integer(p.zeroCount, `${path}.zeroCount`, true);
  const zeroThreshold =
    p.zeroThreshold == null ? 0 : double(p.zeroThreshold, `${path}.zeroThreshold`);
  if (zeroThreshold < 0)
    fail(
      'INVALID_ZERO_THRESHOLD',
      'zeroThreshold must be zero or positive.',
      `${path}.zeroThreshold`,
    );
  const positive = readBuckets(p.positive, scale, `${path}.positive`);
  const negative = readBuckets(p.negative, scale, `${path}.negative`);
  const total = [...positive.bucketCounts, ...negative.bucketCounts].reduce(
    (a, b) => a + b,
    zeroCount,
  );
  if (total !== count)
    fail(
      'BUCKET_COUNT_MISMATCH',
      'zeroCount and the positive and negative bucket counts must sum to the point count.',
      path,
    );
  if (p.sum != null && double(p.sum, `${path}.sum`) !== 0 && count === 0n)
    fail('INVALID_SUM', 'A histogram point with count 0 must have sum 0.', path);
  const min = p.min == null ? undefined : double(p.min, `${path}.min`);
  const max = p.max == null ? undefined : double(p.max, `${path}.max`);
  if (min !== undefined && max !== undefined && min > max)
    fail('INVALID_MIN_MAX', 'The histogram minimum cannot exceed its maximum.', path);
  array(p.exemplars, `${path}.exemplars`);
  return { count, scale, zeroCount, zeroThreshold, positive, negative };
}

const SMALLEST_NORMAL_DOUBLE = 2 ** -1022;

// A duration threshold typed in seconds, kept as the exact decimal it denotes.
export type ExactDuration = { text: string; value: Rational; log2: number };
export function readExactDuration(text: string): ExactDuration {
  if (!text) fail('DURATION_NOT_SELECTED', 'Enter a duration threshold in seconds.');
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  const n = match && text.length <= 64 ? Number(text) : Number.NaN;
  // Below the smallest normal double, Number(text) loses relative precision and log2 errors
  // could exceed LOG2_TOLERANCE, so such a threshold could misclassify a bucket.
  if (!match || !Number.isFinite(n) || n < SMALLEST_NORMAL_DOUBLE)
    fail(
      'INVALID_DURATION_THRESHOLD',
      'The duration threshold must be a finite decimal number of seconds from 2^-1022 (about 2.2e-308) upward, at most 64 characters, using a dot.',
    );
  const [, whole, fraction = '', exp = '0'] = match;
  const power = BigInt(exp) - BigInt(fraction.length);
  const digits = BigInt(whole + fraction);
  const value =
    power >= 0n
      ? { numerator: digits * 10n ** power, denominator: 1n }
      : { numerator: digits, denominator: 10n ** -power };
  return { text, value, log2: Math.log2(n) };
}

// The exact value of a finite nonnegative double.
export function doubleRational(x: number): Rational {
  if (x === 0) return { numerator: 0n, denominator: 1n };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const e = (biased === 0 ? 1 : biased) - 1075;
  return e >= 0
    ? { numerator: mantissa << BigInt(e), denominator: 1n }
    : { numerator: mantissa, denominator: 1n << BigInt(-e) };
}

// Math.log2 is accurate to a few units in the last place; this margin, in log2 units, is
// many orders of magnitude wider. Inside it a boundary is not classified.
export const LOG2_TOLERANCE = 2 ** -30;

// Sign of base^index - threshold, or null when floating-point error could flip it.
// base^index = 2^(index / 2^scale) is a power of two when the exponent is an integer, and
// irrational otherwise (so it never equals a decimal threshold).
function boundarySign(index: number, scale: number, d: ExactDuration): -1 | 0 | 1 | null {
  const { num, den } = exponent(index, scale);
  const x = num / den; // exact: both are safe integers and den is a power of two
  if (Number.isInteger(x)) {
    if (x > d.log2 + 2) return 1;
    if (x < d.log2 - 2) return -1;
    const power =
      x >= 0
        ? { numerator: 1n << BigInt(x), denominator: 1n }
        : { numerator: 1n, denominator: 1n << BigInt(-x) };
    const c = compare(power, d.value);
    return c > 0n ? 1 : c < 0n ? -1 : 0;
  }
  const diff = x - d.log2;
  if (Math.abs(diff) <= LOG2_TOLERANCE) return null;
  return diff > 0 ? 1 : -1;
}

export type CrossingReason = 'threshold_inside_bucket' | 'numerically_ambiguous';
export type ExponentialClassification = {
  fast: bigint;
  slow: bigint;
  uncertain: bigint;
  zero: { count: string; upperBound: string; class: 'fast' | 'uncertain' | 'empty' };
  crossing: { index: number; count: string; reason: CrossingReason }[];
};

// With zeroThreshold 0 the zero bucket holds zero and values the formula cannot express:
// subnormal magnitudes, below the smallest normal double 2^-1022.
const SMALLEST_NORMAL: Rational = { numerator: 1n, denominator: 1n << 1022n };

// Classifies every observation of the positive range and the zero bucket against the
// threshold: fast (<= d), slow (> d) or uncertain (its bucket admits both). The caller
// refuses non-empty negative ranges first.
export function classifyExponential(
  point: ExponentialRead,
  d: ExactDuration,
): ExponentialClassification {
  let fast = 0n;
  let slow = 0n;
  let uncertain = 0n;
  const crossing: ExponentialClassification['crossing'] = [];
  const zeroUpper = point.zeroThreshold > 0 ? doubleRational(point.zeroThreshold) : SMALLEST_NORMAL;
  let zeroClass: ExponentialClassification['zero']['class'] = 'empty';
  if (point.zeroCount > 0n) {
    if (compare(zeroUpper, d.value) <= 0n) {
      zeroClass = 'fast';
      fast += point.zeroCount;
    } else {
      zeroClass = 'uncertain';
      uncertain += point.zeroCount;
    }
  }
  const { offset, bucketCounts } = point.positive;
  for (const [i, c] of bucketCounts.entries()) {
    if (c === 0n) continue;
    const index = offset + i;
    const upper = boundarySign(index + 1, point.scale, d);
    if (upper !== null && upper <= 0) {
      fast += c;
      continue;
    }
    const lower = boundarySign(index, point.scale, d);
    if (lower !== null && lower >= 0) {
      slow += c;
      continue;
    }
    uncertain += c;
    crossing.push({
      index,
      count: c.toString(),
      reason: lower === -1 && upper === 1 ? 'threshold_inside_bucket' : 'numerically_ambiguous',
    });
  }
  return {
    fast,
    slow,
    uncertain,
    zero: {
      count: point.zeroCount.toString(),
      upperBound: point.zeroThreshold > 0 ? String(point.zeroThreshold) : '2^-1022',
      class: zeroClass,
    },
    crossing,
  };
}
