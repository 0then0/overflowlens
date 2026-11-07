import { describe, expect, test } from 'vitest';
import { analyze } from '../src/core/analyze';
import { compare, thresholdPercent } from '../src/core/calculate';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { makeHttpReport } from '../src/core/report';
import type { Rational } from '../src/core/types';
import { fixture, type HttpSpec, httpFixture, importFixture, runHttp } from './helpers';

const stream = (specs: HttpSpec[], metric?: Record<string, unknown>) =>
  importFixture(httpFixture(specs, metric)).streams[0];
const calc = (specs: HttpSpec[], threshold = '1') => runHttp(stream(specs), { threshold });
function code(result: ReturnType<typeof runHttp>) {
  return 'diagnostic' in result ? result.diagnostic.code : result.status;
}
const ratio = (numerator: bigint, denominator: bigint): Rational => ({ numerator, denominator });
const overflow = (count: string | number): HttpSpec => ({ overflow: true, count });

describe('HTTP 5xx bounds', () => {
  test('histogram with overflow: counts, bounds and classification', () => {
    const r = calc(
      [
        { status: 200, count: 700 },
        { status: 404, count: 100 },
        { status: 500, count: 30 },
        { status: 503, count: 20 },
        overflow(150),
      ],
      '10',
    );
    expect(r).toMatchObject({ K: 850n, E: 50n, O: 150n, T: 1000n, status: 'INDETERMINATE' });
    if (!('lower' in r) || !r.lower || !r.upper) throw new Error('expected bounds');
    expect(r.lower).toEqual(ratio(50n, 1000n));
    expect(r.upper).toEqual(ratio(200n, 1000n));
    expect(r.points.map((p) => [p.statusCode, p.responseClass])).toEqual([
      ['200', 'other'],
      ['404', 'other'],
      ['500', 'server_error'],
      ['503', 'server_error'],
      [undefined, undefined],
    ]);
  });
  test.each([
    [100, false],
    [499, false],
    [500, true],
    [599, true],
  ])('status %i is classified as 5xx=%s', (status, server) => {
    const r = calc([{ status, count: 5 }]);
    expect(r).toMatchObject({ K: 5n, E: server ? 5n : 0n });
  });
  test('no overflow gives one exact rate', () => {
    const r = calc([
      { status: 200, count: 97 },
      { status: 502, count: 3 },
    ]);
    expect(r).toMatchObject({ O: 0n, T: 100n });
    if (!('lower' in r) || !r.lower || !r.upper) throw new Error('expected bounds');
    expect(compare(r.lower, r.upper)).toBe(0n);
    expect(r.lower).toEqual(ratio(3n, 100n));
  });
  test.each([
    ['explicit zero counts', [{ status: 200, count: '0' }, overflow('0')]],
    [
      'omitted counts and no buckets',
      [{ status: 200, count: null, point: { bucketCounts: [], explicitBounds: [] } }],
    ],
  ] as [string, HttpSpec[]][])('zero total: %s', (_name, specs) => {
    const r = calc(specs);
    expect(r).toMatchObject({ status: 'NO_DATA', T: 0n, lower: null, upper: null });
  });
  test('counts beyond Number.MAX_SAFE_INTEGER stay exact, including strings and number tokens', () => {
    const max = '18446744073709551615'; // 2^64 - 1
    const raw = JSON.stringify(
      httpFixture([
        { status: 200, count: '9007199254740993' },
        { status: 500, count: max },
        overflow('9007199254740995'),
      ]),
    ).replace('"9007199254740993"', '9007199254740993');
    const r = runHttp(normalize(parseOtlp(raw)).streams[0], { threshold: '0' });
    const K = 9007199254740993n + 18446744073709551615n;
    expect(r).toMatchObject({
      K,
      E: 18446744073709551615n,
      O: 9007199254740995n,
      T: K + 9007199254740995n,
      status: 'EXCEEDS_LIMIT',
    });
    if ('points' in r) expect(r.points.map((p) => p.count)).toContain(max);
  });
  test('counts above uint64 or negative are invalid', () => {
    for (const count of ['18446744073709551616', '-1'])
      expect(stream([{ status: 200, count }]).diagnostics[0].code).toBe('INTEGER_OUT_OF_RANGE');
  });
  test('threshold equality at both bounds, and just outside', () => {
    const specs: HttpSpec[] = [
      { status: 200, count: 80 },
      { status: 500, count: 10 },
      overflow(10),
    ];
    // lower = 10/100, upper = 20/100
    expect(code(calc(specs, '20'))).toBe('WITHIN_LIMIT');
    expect(code(calc(specs, '19.999999999999999999'))).toBe('INDETERMINATE');
    expect(code(calc(specs, '10'))).toBe('INDETERMINATE'); // lower equal to the limit is not above it
    expect(code(calc(specs, '9.999999999999999999'))).toBe('EXCEEDS_LIMIT');
  });
  test('an overflow of only successes or only 5xx stays inside the bounds and attains them', () => {
    for (let K = 0; K <= 6; K++)
      for (let E = 0; E <= K; E++)
        for (let O = 0; O <= 6; O++) {
          const specs: HttpSpec[] = [
            { status: 200, count: K - E },
            { status: 500, count: E },
            overflow(O),
          ];
          const r = calc(specs);
          if (K + O === 0) {
            expect(r.status).toBe('NO_DATA');
            continue;
          }
          if (!('lower' in r) || !r.lower || !r.upper) throw new Error('expected bounds');
          const onlySuccess = ratio(BigInt(E), BigInt(K + O));
          const only5xx = ratio(BigInt(E + O), BigInt(K + O));
          expect(compare(onlySuccess, r.lower)).toBe(0n);
          expect(compare(only5xx, r.upper)).toBe(0n);
          for (let x = 0; x <= O; x++) {
            const truth = ratio(BigInt(E + x), BigInt(K + O));
            expect(compare(truth, r.lower)).toBeGreaterThanOrEqual(0n);
            expect(compare(truth, r.upper)).toBeLessThanOrEqual(0n);
          }
          for (const p of ['0', '12.5', '50', '100']) {
            const limit = thresholdPercent(p);
            const rate = (x: number) => ratio(BigInt(E + x), BigInt(K + O));
            const allWithin = compare(rate(O), limit) <= 0n;
            const allAbove = compare(rate(0), limit) > 0n;
            expect(calc(specs, p).status).toBe(
              allWithin ? 'WITHIN_LIMIT' : allAbove ? 'EXCEEDS_LIMIT' : 'INDETERMINATE',
            );
          }
        }
  });
  test('overflow only: bounds span 0% to 100%', () => {
    const r = calc([overflow(7)]);
    expect(r).toMatchObject({ K: 0n, E: 0n, O: 7n, T: 7n, status: 'INDETERMINATE' });
  });
  test('valid buckets are accepted and may be absent', () => {
    expect(
      calc([{ status: 200, count: 3, point: { bucketCounts: ['1', '2'], explicitBounds: [0.1] } }]),
    ).toMatchObject({ K: 3n });
    expect(
      calc([
        { status: 200, count: 3, point: { bucketCounts: undefined, explicitBounds: undefined } },
      ]),
    ).toMatchObject({ K: 3n });
  });
});

describe('status code refusals', () => {
  test('missing status on an ordinary point', () => {
    const r = calc([{ status: 200 }, { status: null }]);
    expect(r).toMatchObject({
      status: 'INVALID_INPUT',
      diagnostic: { code: 'MISSING_STATUS_CODE' },
    });
    expect(r).not.toHaveProperty('K');
  });
  test.each([
    ['string', '500'],
    ['boolean', true],
    ['too small', 99],
    ['too large', 600],
    ['zero', 0],
    ['negative', -500],
  ] as const)('invalid status (%s)', (_name, status) => {
    expect(code(calc([{ status }]))).toBe('INVALID_STATUS_CODE');
  });
  test('double status is invalid', () => {
    const raw = httpFixture([{ status: 500 }]);
    const point = raw.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
    point.attributes[1] = {
      key: 'http.response.status_code',
      value: { doubleValue: 500 } as never,
    };
    expect(code(runHttp(importFixture(raw).streams[0]))).toBe('INVALID_STATUS_CODE');
  });
  test('error.type that contradicts the status', () => {
    const errorType = (value: string) => ({ key: 'error.type', value: { stringValue: value } });
    expect(code(calc([{ status: 200, attributes: [errorType('500')] }]))).toBe(
      'CONTRADICTORY_STATUS',
    );
    expect(code(calc([{ status: 500, attributes: [errorType('503')] }]))).toBe(
      'CONTRADICTORY_STATUS',
    );
    expect(calc([{ status: 500, count: 2, attributes: [errorType('500')] }])).toMatchObject({
      E: 2n,
    });
    expect(
      calc([{ status: 500, count: 2, attributes: [errorType('java.io.IOException')] }]),
    ).toMatchObject({ E: 2n });
    expect(
      code(
        calc([{ status: 500, attributes: [{ key: 'error.type', value: { intValue: '500' } }] }]),
      ),
    ).toBe('INVALID_ERROR_TYPE');
  });
  test('the status is read from the point, not from the stream resource', () => {
    const raw = httpFixture([{ status: null }]);
    raw.resourceMetrics[0].resource.attributes.push({
      key: 'http.response.status_code',
      value: { intValue: '500' } as never,
    });
    expect(code(runHttp(importFixture(raw).streams[0]))).toBe('MISSING_STATUS_CODE');
  });
});

describe('overflow shape and point identity', () => {
  test('overflow with additional attributes is ambiguous', () => {
    const r = calc([
      { status: 200 },
      {
        overflow: true,
        attributes: [{ key: 'http.response.status_code', value: { intValue: '500' } }],
      },
    ]);
    expect(r).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'AMBIGUOUS_OVERFLOW' },
    });
  });
  test('overflow marker must be boolean true', () => {
    const raw = httpFixture([overflow(1)]);
    raw.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0].attributes = [
      { key: 'otel.metric.overflow', value: { boolValue: false } },
    ];
    expect(code(runHttp(importFixture(raw).streams[0]))).toBe('INVALID_OVERFLOW_MARKER');
  });
  test('repeated overflow points are duplicate identities', () => {
    expect(code(calc([overflow(1), overflow(2)]))).toBe('DUPLICATE_POINT');
  });
});

describe('histogram wire validation blocks the stream', () => {
  const invalid = (point: Record<string, unknown>, expected: string) => {
    const s = stream([
      { status: 200, count: 4 },
      { status: 500, count: 1 },
      { status: 200, point },
    ]);
    expect(s.diagnostics[0]?.code).toBe(expected);
    expect(runHttp(s)).toMatchObject({ diagnostic: { code: expected } });
  };
  test('bucket counts must sum to count', () =>
    invalid(
      { count: '5', bucketCounts: ['2', '2'], explicitBounds: [1] },
      'BUCKET_COUNT_MISMATCH',
    ));
  test('bucket count length must be bounds + 1', () => {
    invalid({ count: '5', bucketCounts: ['5'], explicitBounds: [1] }, 'INVALID_BUCKETS');
    invalid({ count: '5', bucketCounts: ['5', '0', '0'], explicitBounds: [1] }, 'INVALID_BUCKETS');
  });
  test('bounds without buckets are invalid', () =>
    invalid({ count: '5', bucketCounts: [], explicitBounds: [1] }, 'INVALID_BUCKETS'));
  test('bounds must be strictly increasing', () => {
    invalid(
      { count: '2', bucketCounts: ['1', '1', '0'], explicitBounds: [1, 1] },
      'INVALID_BUCKETS',
    );
    invalid(
      { count: '2', bucketCounts: ['1', '1', '0'], explicitBounds: [2, 1] },
      'INVALID_BUCKETS',
    );
  });
  test('negative, fractional or oversized bucket values and nonfinite bounds', () => {
    invalid({ count: '1', bucketCounts: ['-1', '2'], explicitBounds: [1] }, 'INTEGER_OUT_OF_RANGE');
    invalid({ count: '1', bucketCounts: ['1.5', '0'], explicitBounds: [1] }, 'INVALID_INTEGER');
    invalid({ count: '1', bucketCounts: ['1', '0'], explicitBounds: ['NaN'] }, 'INVALID_DOUBLE');
    invalid(
      { count: '1', bucketCounts: ['1', '0'], explicitBounds: ['Infinity'] },
      'INVALID_DOUBLE',
    );
    invalid({ count: '1', bucketCounts: '1' }, 'INVALID_STRUCTURE');
  });
  test('count must be an exact unsigned integer', () => {
    invalid({ count: 1.5 }, 'INVALID_INTEGER');
    invalid({ count: '1e3' }, 'INVALID_INTEGER');
    invalid({ count: {} }, 'INVALID_INTEGER');
  });
  test('sum, min and max must be consistent finite doubles', () => {
    invalid({ count: '0', bucketCounts: ['0', '0'], sum: 1 }, 'INVALID_SUM');
    invalid({ sum: 'NaN' }, 'INVALID_DOUBLE');
    invalid({ min: 2, max: 1 }, 'INVALID_MIN_MAX');
    invalid({ max: 'Infinity' }, 'INVALID_DOUBLE');
  });
  test('flags must be zero', () => {
    const s = stream([{ status: 200, point: { flags: 1 } }]);
    expect(runHttp(s)).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'UNSUPPORTED_FLAGS' },
    });
    invalid({ flags: '4294967296' }, 'INTEGER_OUT_OF_RANGE');
  });
  test.each([
    ['missing start', { startTimeUnixNano: undefined }, 'MISSING_TIMESTAMP'],
    ['zero start', { startTimeUnixNano: '0' }, 'INVALID_INTERVAL'],
    ['end not after start', { timeUnixNano: '1000000000' }, 'INVALID_INTERVAL'],
    ['end beyond uint64', { timeUnixNano: '18446744073709551616' }, 'INTEGER_OUT_OF_RANGE'],
  ])('time bounds: %s', (_name, point, expected) => invalid(point, expected));
  test('a corrupt point in another interval still blocks the selected stream', () => {
    const s = stream([
      { status: 200 },
      {
        status: 200,
        point: {
          startTimeUnixNano: '5000000000',
          timeUnixNano: '6000000000',
          count: '2',
          bucketCounts: ['1', '0'],
        },
      },
    ]);
    expect(runHttp(s)).toMatchObject({ diagnostic: { code: 'BUCKET_COUNT_MISMATCH' } });
  });
  test('an empty histogram has no timestamped interval', () => {
    const raw = httpFixture([]);
    expect(importFixture(raw).streams[0].diagnostics[0].code).toBe('MISSING_INTERVAL');
  });
});

describe('metric scope', () => {
  test('a Sum stream is refused, even with the same name', () => {
    const sum = fixture();
    sum.resourceMetrics[0].scopeMetrics[0].metrics[0].name = 'http.server.request.duration';
    expect(runHttp(importFixture(sum).streams[0])).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'UNSUPPORTED_TYPE' },
    });
  });
  test('another metric name is refused, even with an identical shape', () => {
    expect(
      runHttp(stream([{ status: 200 }], { name: 'http.server.request.body.size' })),
    ).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'UNSUPPORTED_METRIC' },
    });
  });
  test('cumulative histograms are refused without reading their points', () => {
    const raw = httpFixture([{ status: 200 }], {
      histogram: { aggregationTemporality: 2, dataPoints: [{ count: 'garbage' }] },
    });
    const s = importFixture(raw).streams[0];
    expect(s.diagnostics).toEqual([]);
    expect(runHttp(s)).toMatchObject({ diagnostic: { code: 'UNSUPPORTED_TEMPORALITY' } });
  });
  test('exponential histograms are unsupported', () => {
    const raw = httpFixture([{ status: 200 }]);
    const m = raw.resourceMetrics[0].scopeMetrics[0].metrics[0] as Record<string, unknown>;
    m.exponentialHistogram = m.histogram;
    delete m.histogram;
    expect(runHttp(importFixture(raw).streams[0])).toMatchObject({
      diagnostic: { code: 'UNSUPPORTED_TYPE' },
    });
  });
  test('matching name does not confirm the conditions', () => {
    expect(runHttp(stream([{ status: 200 }]), { contractConfirmed: false })).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'PROVENANCE_NOT_CONFIRMED' },
    });
  });
  test('an unselected interval is refused', () => {
    expect(code(runHttp(stream([{ status: 200 }]), { intervalId: '' }))).toBe(
      'INTERVAL_NOT_SELECTED',
    );
  });
  test('Sum analysis still refuses histogram streams and stays independent', () => {
    const s = stream([{ status: 200 }]);
    expect(
      analyze(s, {
        intervalId: s.intervals[0].id,
        outcomeAttribute: 'success',
        errorValue: false,
        threshold: '1',
        contractConfirmed: true,
      }),
    ).toMatchObject({ diagnostic: { code: 'UNSUPPORTED_TYPE' } });
  });
  test('Sum streams in the same file stay analyzable next to the histogram', () => {
    const raw = httpFixture([{ status: 200 }]);
    raw.resourceMetrics[0].scopeMetrics[0].metrics.push(
      fixture().resourceMetrics[0].scopeMetrics[0].metrics[0] as never,
    );
    const data = importFixture(raw);
    expect(data.streams).toHaveLength(2);
    expect(data.streams.every((s) => s.diagnostics.length === 0)).toBe(true);
  });
});

describe('HTTP report', () => {
  const s = stream([{ status: 200, count: 8 }, { status: 500, count: 1 }, overflow(1)]);
  const settings = { intervalId: s.intervals[0].id, threshold: '10', contractConfirmed: true };
  const source = { name: 'a.json', sha256: 'f'.repeat(64), bytes: 12 };
  const report = JSON.parse(makeHttpReport(s, settings, runHttp(s, settings), source));
  test('records input metric, criterion, hash, boundaries, conditions and exact results', () => {
    expect(report).toMatchObject({
      reportVersion: '3',
      mode: 'http-5xx-histogram',
      source,
      inputMetric: {
        name: 'http.server.request.duration',
        type: 'Histogram',
        temporality: 'DELTA',
        buckets: 'explicit',
      },
      classification: {
        criterion: 'HTTP 5xx',
        attribute: 'http.response.status_code',
        errorStatusCodes: '500-599',
      },
      interval: { startTimeUnixNano: '1000000000', timeUnixNano: '2000000000' },
      assumptions: { userConfirmed: true, nameMatchProvesConditions: false },
      result: {
        status: 'INDETERMINATE',
        K: '9',
        E: '1',
        O: '1',
        T: '10',
        lower: { numerator: '1', denominator: '10' },
        upper: { numerator: '2', denominator: '10' },
      },
    });
    expect(report.assumptions.conditions).toHaveLength(3);
    expect(report.result.points[0]).toMatchObject({ statusCode: '200', responseClass: 'other' });
  });
  test('a refusal keeps context but has no invented totals', () => {
    const refused = JSON.parse(
      makeHttpReport(
        s,
        { ...settings, contractConfirmed: false },
        runHttp(s, { ...settings, contractConfirmed: false }),
        source,
      ),
    );
    expect(refused.result).toMatchObject({ diagnostic: { code: 'PROVENANCE_NOT_CONFIRMED' } });
    expect(refused.result).not.toHaveProperty('K');
    expect(refused.witnesses).toBeNull();
  });
});
