import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import {
  classifyExponential,
  doubleRational,
  type ExponentialRead,
  readExactDuration,
  readExponentialPoint,
} from '../src/core/exponential';
import { makeRouteSlowReport } from '../src/core/report';
import {
  analyzeRouteSlowShare,
  calculateRouteSlowShare,
  durationCandidates,
  prepareRouteSlowShare,
  type RouteSlowSettings,
  routeCandidates,
} from '../src/core/routeSlow';
import type { Rational } from '../src/core/types';
import { type ExpSpec, expRouteFixture, importFixture, routeFixture } from './helpers';

const ratio = (numerator: bigint, denominator: bigint): Rational => ({ numerator, denominator });
const stream = (specs: ExpSpec[], metric?: Record<string, unknown>) =>
  importFixture(expRouteFixture(specs, metric)).streams[0];
const settings = (
  s: ReturnType<typeof stream>,
  over: Partial<RouteSlowSettings> = {},
): RouteSlowSettings => ({
  intervalId: s.intervals[0]?.id ?? '',
  route: '/checkout',
  durationSeconds: '0.75',
  maxSlowPercent: '50',
  contractConfirmed: true,
  ...over,
});
const run = (specs: ExpSpec[], over: Partial<RouteSlowSettings> = {}) => {
  const s = stream(specs);
  return analyzeRouteSlowShare(s, settings(s, over));
};
const code = (r: ReturnType<typeof run>) => ('diagnostic' in r ? r.diagnostic.code : r.status);
function bounds(r: ReturnType<typeof run>) {
  if (!('lower' in r) || !r.lower || !r.upper) throw new Error(`expected bounds: ${code(r)}`);
  return { lower: r.lower, upper: r.upper };
}
const checkout = (buckets: (number | string)[], extra: ExpSpec = {}): ExpSpec => ({
  route: '/checkout',
  buckets,
  ...extra,
});
const overflow = (buckets: (number | string)[], extra: ExpSpec = {}): ExpSpec => ({
  overflow: true,
  buckets,
  ...extra,
});

// Scale 0, offset -2: (0.25, 0.5], (0.5, 1], (1, 2]. At 0.75 s these are fast, uncertain, slow.
describe('exponential route slow-share bounds', () => {
  test('a threshold inside a bucket makes its observations uncertain even without overflow', () => {
    const r = run([checkout([60, 30, 10]), { route: '/cart', buckets: [5, 5, 5] }], {
      maxSlowPercent: '20',
    });
    expect(r).toMatchObject({ K: 100n, E: 10n, B: 30n, F: 0n, S: 0n, X: 0n, other: 15n });
    expect(bounds(r)).toEqual({ lower: ratio(10n, 100n), upper: ratio(40n, 100n) });
    expect(r.status).toBe('INDETERMINATE');
  });

  test('overflow adds route uncertainty: L/(K+F_max) and (U+S_max)/(K+S_max)', () => {
    const r = run([checkout([60, 30, 10]), overflow([7, 3, 2])]);
    // L=10, U=40, F_max=7+3, S_max=2+3.
    expect(r).toMatchObject({ K: 100n, E: 10n, B: 30n, F: 7n, S: 2n, X: 3n });
    expect(bounds(r)).toEqual({ lower: ratio(10n, 110n), upper: ratio(45n, 105n) });
  });

  test('a threshold exactly on a bucket boundary leaves nothing uncertain', () => {
    // 1 s is the upper bound of (0.5, 1]: equal durations are fast; (1, 2] is slow.
    const r = run([checkout([60, 30, 10]), overflow([1, 2, 3])], { durationSeconds: '1' });
    expect(r).toMatchObject({ K: 100n, E: 10n, B: 0n, F: 3n, S: 3n, X: 0n });
    expect(bounds(r)).toEqual({ lower: ratio(10n, 103n), upper: ratio(13n, 103n) });
    // 0.5 s: (0.25, 0.5] fast, the rest slow. Equivalent spellings are the same number.
    for (const d of ['0.5', '0.50', '5e-1', '0.05e1'])
      expect(run([checkout([60, 30, 10])], { durationSeconds: d })).toMatchObject({
        E: 40n,
        B: 0n,
      });
  });

  test('at scale 2 a power of two is a boundary; other values lie inside a bucket', () => {
    // Scale 2: base 2^(1/4). Index -4 is (2^-1, 2^-0.75], index -5 is (2^-1.25, 2^-1].
    const specs = [checkout([5, 7], { scale: 2, offset: -5 })];
    expect(run(specs, { durationSeconds: '0.5' })).toMatchObject({ K: 12n, E: 7n, B: 0n });
    // 0.55 lies in (0.5, 0.5946...]; 0.6 is above 2^-0.75 = 0.5946...
    expect(run(specs, { durationSeconds: '0.55' })).toMatchObject({ E: 0n, B: 7n });
    expect(run(specs, { durationSeconds: '0.6' })).toMatchObject({ E: 0n, B: 0n });
  });

  test('each point uses its own scale and offset; distributions are never merged', () => {
    const r = run([
      checkout([4, 6], { scale: 1, offset: -2 }), // (2^-1, 2^-0.5], (2^-0.5, 1]: 0.5..0.707, 0.707..1
      checkout([8], { scale: -1, offset: -1, attributes: [kv('m', 'POST')] }), // (1/4, 1]
      overflow([3, 5, 2], { scale: 3, offset: -3 }), // (2^(-3/8), 2^(-2/8)], ..., (2^(-1/8), 1]
    ]);
    // At 0.75: (0.5, 0.707] is fast, (0.707, 1] and (0.25, 1] cross it, and every overflow
    // bucket starts above 2^(-3/8) = 0.771, so it is slow.
    expect(r).toMatchObject({ K: 18n, E: 0n, B: 14n, F: 0n, S: 10n, X: 0n });
    expect(bounds(r)).toEqual({ lower: ratio(0n, 18n), upper: ratio(24n, 28n) });
  });

  test('the zero bucket follows zeroThreshold', () => {
    // zeroThreshold 0: zero and subnormal magnitudes, so fast for any normal threshold.
    expect(run([checkout([0, 0, 1], { zeroCount: 9 })])).toMatchObject({ K: 10n, E: 1n, B: 0n });
    // [-zeroThreshold, zeroThreshold] crosses a smaller threshold and is fast at a larger one.
    const z = checkout([0, 0, 1], { zeroCount: 9, zeroThreshold: 0.001 });
    expect(run([z], { durationSeconds: '0.0005' })).toMatchObject({ E: 1n, B: 9n });
    expect(run([z], { durationSeconds: '0.0011' })).toMatchObject({ E: 1n, B: 0n });
    // The closed bound is the stored double, which is slightly above the decimal 0.001, so
    // the zero region reaches past a typed 0.001 s and stays uncertain.
    expect(compare(doubleRational(0.001), readExactDuration('0.001').value)).toBeGreaterThan(0n);
    expect(run([z], { durationSeconds: '0.001' })).toMatchObject({ B: 9n });
    // A threshold equal to an exactly representable zeroThreshold is fast (closed bound).
    const exact = checkout([0, 0, 1], { zeroCount: 9, zeroThreshold: 0.5 });
    expect(run([exact], { durationSeconds: '0.5' })).toMatchObject({ E: 1n, B: 0n });
  });

  test('no observations of the selected route keep the existing result', () => {
    const r = run([{ route: '/cart', buckets: [1, 2, 3] }, overflow([1, 1, 1])]);
    expect(r).toMatchObject({
      status: 'NO_ROUTE_OBSERVATIONS',
      K: 0n,
      F: 1n,
      S: 1n,
      X: 1n,
      lower: null,
      upper: null,
    });
  });

  test('a bound equal to the limit is within it; anything stricter is not', () => {
    // K=100, L=10, U=20, no overflow: 10% ... 20%.
    const specs = [checkout([80, 10, 10])];
    expect(run(specs, { maxSlowPercent: '20' }).status).toBe('WITHIN_LIMIT');
    expect(run(specs, { maxSlowPercent: '19.999999999999999999' }).status).toBe('INDETERMINATE');
    expect(run(specs, { maxSlowPercent: '10' }).status).toBe('INDETERMINATE');
    expect(run(specs, { maxSlowPercent: '9.999999999999999999' }).status).toBe('EXCEEDS_LIMIT');
  });

  test('reuses the preparation when only the limit changes', () => {
    const s = stream([checkout([80, 10, 10]), overflow([0, 5, 0])]);
    const prepared = prepareRouteSlowShare(s, settings(s));
    if (prepared.status !== 'APPLICABLE') throw new Error('expected a preparation');
    expect(prepared.histogram).toBe('exponential');
    expect(
      ['30', '15', '5'].map(
        (p) =>
          calculateRouteSlowShare(prepared, { maxSlowPercent: p, contractConfirmed: true }).status,
      ),
    ).toEqual(['WITHIN_LIMIT', 'INDETERMINATE', 'EXCEEDS_LIMIT']);
  });

  test('a threshold within rounding of an irrational boundary is uncertain, never guessed', () => {
    // Scale 1: (1, 2^0.5], (2^0.5, 2]. The double nearest sqrt(2) is not sqrt(2) itself, but
    // telling them apart needs more precision than Math.log2 guarantees.
    const s = stream([checkout([3, 4], { scale: 1, offset: 0 })]);
    const r = analyzeRouteSlowShare(s, settings(s, { durationSeconds: '1.4142135623730951' }));
    expect(r).toMatchObject({ K: 7n, E: 0n, B: 7n });
    if (!('points' in r)) throw new Error('expected points');
    expect(r.points[0].exponential?.classification.crossing).toEqual([
      { index: 0, count: '3', reason: 'numerically_ambiguous' },
      { index: 1, count: '4', reason: 'numerically_ambiguous' },
    ]);
    // Clearly away from the boundary the buckets are classified.
    expect(analyzeRouteSlowShare(s, settings(s, { durationSeconds: '1.5' }))).toMatchObject({
      E: 0n,
      B: 4n,
    });
  });

  test('counts beyond Number.MAX_SAFE_INTEGER stay exact', () => {
    const big = 9007199254740993n;
    const r = run([
      checkout([big.toString(), '1', big.toString()]),
      overflow(['1', big.toString(), '0']),
    ]);
    expect(r).toMatchObject({ K: 2n * big + 1n, E: big, B: 1n, F: 1n, X: big });
    expect(bounds(r)).toEqual({
      lower: ratio(big, 2n * big + 1n + 1n + big),
      upper: ratio(big + 1n + big, 2n * big + 1n + big),
    });
  });
});

const kv = (key: string, value: string) => ({ key, value: { stringValue: value } });

describe('exponential applicability', () => {
  test.each([
    ['count above the buckets', checkout([1, 1, 1], { count: 4 }), 'BUCKET_COUNT_MISMATCH'],
    ['count below zeroCount', checkout([0], { zeroCount: 3, count: 2 }), 'BUCKET_COUNT_MISMATCH'],
    ['fractional count', checkout([1], { count: '1.0' }), 'INVALID_INTEGER'],
    ['negative bucket count', checkout(['-1', '2']), 'INTEGER_OUT_OF_RANGE'],
    ['scale 21', checkout([1], { scale: 21 }), 'UNSUPPORTED_SCALE'],
    ['scale -11', checkout([1], { scale: -11 }), 'UNSUPPORTED_SCALE'],
    ['a fractional scale', checkout([1], { point: { scale: 1.5 } }), 'INVALID_INTEGER'],
    ['an offset beyond int32', checkout([1], { offset: 2 ** 31 }), 'INTEGER_OUT_OF_RANGE'],
    [
      'an index range beyond int32',
      checkout([0, 1], { offset: 2 ** 31 - 1 }),
      'INVALID_BUCKET_INDEX',
    ],
    ['a bucket above every double', checkout([1], { offset: 1024 }), 'INVALID_BUCKET_INDEX'],
    ['a bucket below every double', checkout([1], { offset: -1076 }), 'INVALID_BUCKET_INDEX'],
    ['negative zeroThreshold', checkout([1], { zeroThreshold: -1 }), 'INVALID_ZERO_THRESHOLD'],
    ['nonzero sum with count 0', checkout([0], { point: { sum: 1 } }), 'INVALID_SUM'],
    ['min above max', checkout([1], { point: { min: 2, max: 1 } }), 'INVALID_MIN_MAX'],
  ] as [string, ExpSpec, string][])('%s is refused at import', (_name, bad, expected) => {
    const r = run([checkout([1, 0, 0]), bad]);
    expect(code(r)).toBe(expected);
    expect(r).not.toHaveProperty('K');
  });

  test('bucket ranges are limited in size', () => {
    expect(code(run([checkout(new Array(16_385).fill(0))]))).toBe('TOO_MANY_BUCKETS');
    expect(run([checkout([...new Array(16_383).fill(0), 1], { offset: -16_000 })])).toMatchObject({
      K: 1n,
    });
  });

  test('a bucket at the edge of the double range is accepted when it can hold a value', () => {
    expect(run([checkout([1], { offset: 1023 })])).toMatchObject({ K: 1n, E: 1n });
    expect(run([checkout([1], { offset: -1075 })])).toMatchObject({ K: 1n, E: 0n });
  });

  test('non-empty negative buckets refuse the calculation; empty ones are fine', () => {
    expect(code(run([checkout([1], { negative: { bucketCounts: [0, 2] } })]))).toBe(
      'NEGATIVE_DURATIONS',
    );
    // Even on a point of another route: the data contradict the duration model.
    expect(
      code(run([checkout([1]), { route: '/cart', buckets: [1], negative: { bucketCounts: [1] } }])),
    ).toBe('NEGATIVE_DURATIONS');
    expect(run([checkout([1], { negative: { offset: 3, bucketCounts: [0, 0] } })])).toMatchObject({
      K: 1n,
    });
  });

  test('the overflow marker shape, routes and duplicates follow the existing rules', () => {
    expect(code(run([checkout([1]), { ...overflow([1]), attributes: [kv('a', 'b')] }]))).toBe(
      'AMBIGUOUS_OVERFLOW',
    );
    expect(code(run([checkout([1]), { route: null, buckets: [1] }]))).toBe('MISSING_ROUTE');
    const raw = expRouteFixture([checkout([1])]);
    const points = (
      raw.resourceMetrics[0].scopeMetrics[0].metrics[0] as unknown as {
        exponentialHistogram: { dataPoints: unknown[] };
      }
    ).exponentialHistogram.dataPoints;
    points.push(structuredClone(points[0]));
    const s = importFixture(raw).streams[0];
    expect(code(analyzeRouteSlowShare(s, settings(s)))).toBe('DUPLICATE_POINT');
  });

  test('cumulative temporality, other units and unconfirmed provenance are refused', () => {
    const raw = expRouteFixture([checkout([1])]);
    (
      raw.resourceMetrics[0].scopeMetrics[0].metrics[0] as unknown as {
        exponentialHistogram: { aggregationTemporality: number };
      }
    ).exponentialHistogram.aggregationTemporality = 2;
    const c = importFixture(raw).streams[0];
    expect(code(analyzeRouteSlowShare(c, settings(c, { intervalId: '1:2' })))).toBe(
      'UNSUPPORTED_TEMPORALITY',
    );
    const ms = importFixture(expRouteFixture([checkout([1])], { unit: 'ms' })).streams[0];
    expect(code(analyzeRouteSlowShare(ms, settings(ms)))).toBe('UNSUPPORTED_UNIT');
    expect(code(run([checkout([1])], { contractConfirmed: false }))).toBe(
      'PROVENANCE_NOT_CONFIRMED',
    );
  });

  test.each([
    ['', 'DURATION_NOT_SELECTED'],
    ['0', 'INVALID_DURATION_THRESHOLD'],
    ['-1', 'INVALID_DURATION_THRESHOLD'],
    ['1,5', 'INVALID_DURATION_THRESHOLD'],
    ['.5', 'INVALID_DURATION_THRESHOLD'],
    ['1e999', 'INVALID_DURATION_THRESHOLD'],
    ['1e-999', 'INVALID_DURATION_THRESHOLD'],
    // Subnormal: too imprecise as a double to classify buckets safely.
    ['1e-320', 'INVALID_DURATION_THRESHOLD'],
    [`0.${'0'.repeat(70)}1`, 'INVALID_DURATION_THRESHOLD'],
  ])('typed threshold %j', (durationSeconds, expected) => {
    expect(code(run([checkout([1])], { durationSeconds }))).toBe(expected);
  });

  test('the smallest normal threshold is accepted', () => {
    expect(run([checkout([1])], { durationSeconds: '2.3e-308' })).toMatchObject({ K: 1n, E: 1n });
  });

  test('routes are offered, boundaries are typed', () => {
    const s = stream([checkout([1]), { route: '/cart', buckets: [1] }, overflow([1])]);
    expect(routeCandidates(s, s.intervals[0].id)).toEqual(['/cart', '/checkout']);
    expect(durationCandidates(s, s.intervals[0].id, '/checkout')).toEqual([]);
  });
});

// Exact oracle, independent of Math.log2: for scale s >= 0, 2^(k/2^s) > d = N/D exactly when
// 2^k * D^(2^s) > N^(2^s); for s < 0 the bound 2^(k * 2^-s) is a power of two.
function boundaryAbove(k: number, s: number, d: Rational): -1 | 0 | 1 {
  let left: bigint;
  let right: bigint;
  if (s >= 0) {
    const p = 2n ** BigInt(s);
    left = k >= 0 ? 2n ** BigInt(k) * d.denominator ** p : d.denominator ** p;
    right = k >= 0 ? d.numerator ** p : d.numerator ** p * 2n ** BigInt(-k);
  } else {
    const e = k * 2 ** -s;
    left = e >= 0 ? 2n ** BigInt(e) * d.denominator : d.denominator;
    right = e >= 0 ? d.numerator : d.numerator * 2n ** BigInt(-e);
  }
  return left > right ? 1 : left < right ? -1 : 0;
}

describe('bucket classification against an exact oracle', () => {
  test('every bucket of scales -3..3 near many thresholds', () => {
    const thresholds = ['0.001', '0.1', '0.25', '0.3', '0.5', '0.75', '1', '1.2', '2', '3', '10'];
    let checked = 0;
    for (const text of thresholds) {
      const d = readExactDuration(text);
      for (let scale = -3; scale <= 3; scale++) {
        const offset = -12 * 2 ** Math.max(scale, 0);
        const counts = new Array(24 * 2 ** Math.max(scale, 0))
          .fill(0n)
          .map((_, i) => BigInt(i + 1));
        const point: ExponentialRead = {
          count: counts.reduce((a, b) => a + b, 0n),
          scale,
          zeroCount: 0n,
          zeroThreshold: 0,
          positive: { offset, bucketCounts: counts },
          negative: { offset: 0, bucketCounts: [] },
        };
        const c = classifyExponential(point, d);
        let fast = 0n;
        let slow = 0n;
        let uncertain = 0n;
        for (const [i, n] of counts.entries()) {
          const lower = boundaryAbove(offset + i, scale, d.value);
          const upper = boundaryAbove(offset + i + 1, scale, d.value);
          if (upper <= 0) fast += n;
          else if (lower >= 0) slow += n;
          else uncertain += n;
          checked++;
        }
        expect([c.fast, c.slow, c.uncertain], `${text} at scale ${scale}`).toEqual([
          fast,
          slow,
          uncertain,
        ]);
      }
    }
    expect(checked).toBeGreaterThan(4_500);
  });

  test('wire parsing keeps each point independent', () => {
    const p = readExponentialPoint(
      {
        count: '6',
        scale: '-2',
        zeroCount: 1,
        positive: { offset: '-1', bucketCounts: ['2', 3] },
      } as Record<string, unknown>,
      'p',
    );
    expect(p).toMatchObject({ scale: -2, zeroCount: 1n, positive: { offset: -1 } });
  });
});

describe('exhaustive check of the bounds', () => {
  // Known route: a certainly fast, b certainly slow, c uncertain requests (K = a + b + c).
  // Overflow: Fo certainly fast, So certainly slow, Xo uncertain observations, any of which may
  // belong to the route. Enumerate every resolution of the uncertain known requests (e slow),
  // every split of the overflow by route (f, s, x owned) and of the owned uncertain overflow by
  // side (y slow), and compare the extreme shares with the reported bounds.
  test('lower and upper are the minimum and maximum over all resolutions and assignments', () => {
    let assignments = 0;
    for (let a = 0; a <= 2; a++)
      for (let b = 0; b <= 2; b++)
        for (let c = 0; c <= 2; c++) {
          const K = a + b + c;
          if (K === 0) continue;
          for (let Fo = 0; Fo <= 2; Fo++)
            for (let So = 0; So <= 2; So++)
              for (let Xo = 0; Xo <= 2; Xo++) {
                const r = run([
                  checkout([a, c, b]),
                  { route: '/other', buckets: [1, 1, 1] },
                  overflow([Fo, Xo, So]),
                ]);
                const { lower, upper } = bounds(r);
                let min: Rational | undefined;
                let max: Rational | undefined;
                for (let e = 0; e <= c; e++)
                  for (let f = 0; f <= Fo; f++)
                    for (let s = 0; s <= So; s++)
                      for (let x = 0; x <= Xo; x++)
                        for (let y = 0; y <= x; y++) {
                          const share = ratio(BigInt(b + e + s + y), BigInt(K + f + s + x));
                          if (!min || compare(share, min) < 0n) min = share;
                          if (!max || compare(share, max) > 0n) max = share;
                          assignments++;
                        }
                if (!min || !max) throw new Error('empty enumeration');
                expect(compare(lower, min), JSON.stringify({ a, b, c, Fo, So, Xo })).toBe(0n);
                expect(compare(upper, max), JSON.stringify({ a, b, c, Fo, So, Xo })).toBe(0n);
              }
        }
    expect(assignments).toBeGreaterThan(10_000);
  });
});

describe('explanatory report v6', () => {
  const build = (specs: ExpSpec[], over: Partial<RouteSlowSettings> = {}) => {
    const s = stream(specs);
    const set = settings(s, over);
    const prepared = prepareRouteSlowShare(s, set);
    const result = calculateRouteSlowShare(prepared, set);
    const source = { name: 'in.json', sha256: 'e'.repeat(64), bytes: 1 };
    return JSON.parse(makeRouteSlowReport(s, set, prepared, result, source));
  };
  test('records the threshold, bounds, counts, point classification and provenance', () => {
    const r = build([checkout([60, 30, 10]), overflow([7, 3, 2])]);
    expect(r).toMatchObject({
      reportVersion: '6',
      mode: 'http-route-slow-share-exponential-histogram',
      source: { sha256: 'e'.repeat(64) },
      inputMetric: { type: 'ExponentialHistogram', unit: 's' },
      selection: { durationThreshold: { seconds: '0.75', unit: 's' } },
      assumptions: {
        userConfirmed: true,
        structurallyProven: false,
        overflowMarkerProvesProvenance: false,
      },
      applicability: { status: 'APPLICABLE' },
      counts: {
        K: '100',
        L: '10',
        U: '40',
        F_max: '10',
        S_max: '5',
        knownUncertain: '30',
        overflowUncertain: '3',
        uncertainFromThreshold: '33',
        uncertainFromLostRoute: '12',
      },
      model: { lower: 'L / (K + F_max)', upper: '(U + S_max) / (K + S_max)' },
      result: {
        status: 'WITHIN_LIMIT',
        lower: { numerator: '10', denominator: '110' },
        upper: { numerator: '45', denominator: '105' },
      },
      witnesses: {
        lower: { overflowFastOfSelectedRoute: '10', overflowSlowOfSelectedRoute: '0' },
        upper: { overflowFastOfSelectedRoute: '0', overflowSlowOfSelectedRoute: '5' },
      },
    });
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toMatchObject({
      role: 'selected_route',
      fast: '60',
      slow: '10',
      uncertain: '30',
      exponential: {
        scale: 0,
        positive: { offset: -2, bucketCounts: ['60', '30', '10'] },
        classification: {
          crossing: [{ index: -1, count: '30', reason: 'threshold_inside_bucket' }],
        },
      },
    });
    // The report replays its own bounds from the exported counts.
    const c = r.counts;
    expect(r.result.lower).toEqual({
      numerator: c.L,
      denominator: String(BigInt(c.K) + BigInt(c.F_max)),
    });
    expect(r.result.upper).toEqual({
      numerator: String(BigInt(c.U) + BigInt(c.S_max)),
      denominator: String(BigInt(c.K) + BigInt(c.S_max)),
    });
  });
  test('refusals and K = 0 export no counts or bounds', () => {
    const refused = build([checkout([1], { negative: { bucketCounts: [1] } })]);
    expect(refused.result.diagnostic.code).toBe('NEGATIVE_DURATIONS');
    expect(refused.counts).toBeNull();
    expect(refused.points).toBeNull();
    const none = build([{ route: '/cart', buckets: [1] }, overflow([1, 1, 1])]);
    expect(none.result.status).toBe('NO_ROUTE_OBSERVATIONS');
    expect(none.witnesses).toBeNull();
    expect(none.result.lower).toBeNull();
  });
  test('explicit-bucket reports keep schema v5 without the new fields', () => {
    const s = importFixture(
      routeFixture([
        { route: '/checkout', buckets: [8, 0, 2, 0] },
        { overflow: true, buckets: [3, 0, 1, 0] },
      ]),
    ).streams[0];
    const set = settings(s as never, { durationSeconds: '0.5' });
    const prepared = prepareRouteSlowShare(s, set);
    const result = calculateRouteSlowShare(prepared, set);
    const r = JSON.parse(
      makeRouteSlowReport(s, set, prepared, result, { name: 'x', sha256: '0', bytes: 1 }),
    );
    expect(r.reportVersion).toBe('5');
    expect(Object.keys(r.result).sort()).toEqual([
      'E',
      'F',
      'K',
      'S',
      'durationSeconds',
      'lower',
      'maximum',
      'other',
      'route',
      'status',
      'upper',
    ]);
    expect(r.points[0]).not.toHaveProperty('uncertain');
    expect(r.points[0]).not.toHaveProperty('exponential');
    expect(r.applicability.checks[0]).toContain('explicit-bucket Histogram');
  });
});
