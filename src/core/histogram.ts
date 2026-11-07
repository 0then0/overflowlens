import { array, double, integer } from './parse';
import { fail, type ObjectValue } from './types';

// Wire validation of one explicit-bucket HistogramDataPoint, following the OTLP
// metrics proto. Timestamps are validated by the caller. The point may be raw
// parser output or the materialized copy kept in an interval.
export type HistogramRead = { count: bigint; bounds: number[]; buckets: bigint[] };
export function readHistogramPoint(p: ObjectValue, path: string): HistogramRead {
  if (p.flags != null && integer(p.flags, `${path}.flags`, true, 32) !== 0n)
    fail(
      'UNSUPPORTED_FLAGS',
      'Points flagged as missing observations or with unknown flags cannot be counted.',
      path,
      'UNSUPPORTED_INPUT',
    );
  // proto3 JSON encoders omit a zero count, so an absent count is zero.
  const count = p.count == null ? 0n : integer(p.count, `${path}.count`, true);
  const buckets = array(p.bucketCounts, `${path}.bucketCounts`).map((v, i) =>
    integer(v, `${path}.bucketCounts[${i}]`, true),
  );
  const bounds = array(p.explicitBounds, `${path}.explicitBounds`).map((v, i) =>
    double(v, `${path}.explicitBounds[${i}]`),
  );
  if (buckets.length === 0 ? bounds.length !== 0 : buckets.length !== bounds.length + 1)
    fail(
      'INVALID_BUCKETS',
      'bucketCounts must have exactly one more element than explicitBounds, or both must be empty.',
      path,
    );
  for (let i = 1; i < bounds.length; i++)
    if (!(bounds[i] > bounds[i - 1]))
      fail('INVALID_BUCKETS', 'explicitBounds must be strictly increasing.', path);
  if (buckets.length > 0 && buckets.reduce((a, b) => a + b, 0n) !== count)
    fail('BUCKET_COUNT_MISMATCH', 'The bucketCounts must sum to the point count.', path);
  if (p.sum != null && double(p.sum, `${path}.sum`) !== 0 && count === 0n)
    fail('INVALID_SUM', 'A histogram point with count 0 must have sum 0.', path);
  const min = p.min == null ? undefined : double(p.min, `${path}.min`);
  const max = p.max == null ? undefined : double(p.max, `${path}.max`);
  if (min !== undefined && max !== undefined && min > max)
    fail('INVALID_MIN_MAX', 'The histogram minimum cannot exceed its maximum.', path);
  array(p.exemplars, `${path}.exemplars`);
  return { count, bounds, buckets };
}
