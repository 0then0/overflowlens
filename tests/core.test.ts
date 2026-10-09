import { describe, expect, test } from 'vitest';
import { analyze } from '../src/core/analyze';
import { calculate, compare, formatPercent, thresholdPercent } from '../src/core/calculate';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { makeReport } from '../src/core/report';
import { MAX_FILE_BYTES, type Rational } from '../src/core/types';
import { fixture, importFixture, run } from './helpers';

function counts(s: string, e: string, o: string | null, p = '1') {
  return run(importFixture(fixture(s, e, o)).streams[0], { threshold: p });
}
function code(raw: unknown) {
  const data = importFixture(raw);
  const r = run(data.streams[0]);
  return 'diagnostic' in r ? r.diagnostic.code : r.status;
}
const sum = (f: ReturnType<typeof fixture>) => f.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
describe('exact calculation', () => {
  test('900 / 1 / 99', () => {
    const r = counts('900', '1', '99');
    expect(r).toMatchObject({
      K: 901n,
      E: 1n,
      O: 99n,
      T: 1000n,
      status: 'INDETERMINATE',
      lower: { numerator: 1n, denominator: 1000n },
      upper: { numerator: 100n, denominator: 1000n },
    });
    if ('lower' in r && r.lower && r.upper)
      expect([formatPercent(r.lower), formatPercent(r.upper)]).toEqual(['0.1%', '10%']);
  });
  test.each([
    ['exact', '99', '1', null, '1', 'WITHIN_LIMIT'],
    ['all success', '100', '0', null, '0', 'WITHIN_LIMIT'],
    ['all error', '0', '100', null, '99', 'EXCEEDS_LIMIT'],
    ['overflow only', '0', '0', '100', '1', 'INDETERMINATE'],
    ['zero', '0', '0', '0', '1', 'NO_DATA'],
    ['upper equality', '900', '1', '99', '10', 'WITHIN_LIMIT'],
    ['lower equality', '900', '1', '99', '0.1', 'INDETERMINATE'],
    ['just below lower', '900', '1', '99', '0.099999999999999999', 'EXCEEDS_LIMIT'],
    ['inside', '900', '1', '99', '5', 'INDETERMINATE'],
  ])('%s', (_name, s, e, o, p, status) => {
    expect(counts(s, e, o, p).status).toBe(status);
  });
  test('empty counter has no artificial fraction', () => {
    expect(counts('0', '0', null)).toMatchObject({ status: 'NO_DATA', lower: null, upper: null });
  });
  test('overflow-only point needs no ordinary outcome', () => {
    const f = fixture();
    sum(f).dataPoints = sum(f).dataPoints.slice(2);
    expect(code(f)).toBe('INDETERMINATE');
  });
  test('large signed int64 strings', () => {
    const r = counts('9007199254740993', '1', '1', '0');
    expect(r).toMatchObject({ T: 9007199254740995n, E: 1n, status: 'EXCEEDS_LIMIT' });
  });
  test('large numeric tokens remain exact', () => {
    const text = JSON.stringify(fixture('9223372036854775807', '0', null)).replace(
      '"9223372036854775807"',
      '9223372036854775807',
    );
    expect(run(normalize(parseOtlp(text)).streams[0])).toMatchObject({ K: 9223372036854775807n });
  });
  test('small nonzero fraction is not displayed as zero', () => {
    const r = { numerator: 1n, denominator: 9223372036854775807n };
    expect(formatPercent(r)).toBe('<0.000001%');
    expect(compare(r, thresholdPercent('0'))).toBeGreaterThan(0n);
  });
  test('counts may sum beyond int64', () => {
    expect(counts('9223372036854775807', '9223372036854775807', null)).toMatchObject({
      T: 18446744073709551614n,
    });
  });
  test('numeric OTLP integers', () => {
    expect(run(importFixture(fixture(900, 1, 99)).streams[0])).toMatchObject({ K: 901n, O: 99n });
  });
  test('precise percent threshold', () => {
    expect(thresholdPercent('0.000000000000000001')).toEqual({
      numerator: 1n,
      denominator: 100000000000000000000n,
    });
  });
  test.each(['-1', '100.0001', '1e0', 'NaN', '1,2', '', ' 1 ', '1.', '.1'])(
    'reject threshold %s',
    (p) => {
      expect(() => thresholdPercent(p)).toThrow();
    },
  );
  test('error value true reverses ordinary errors', () => {
    expect(run(importFixture(fixture()).streams[0], { errorValue: true })).toMatchObject({
      E: 900n,
      status: 'EXCEEDS_LIMIT',
    });
  });
  test('enumerate every possible overflow error count and verdict', () => {
    let checked = 0;
    for (let k = 0n; k <= 7n; k++)
      for (let e = 0n; e <= k; e++)
        for (let o = 0n; o <= 7n; o++)
          for (let p = 0n; p <= 10n; p++) {
            const threshold: Rational = { numerator: p, denominator: 10n };
            const r = calculate(k, e, o, threshold);
            if (r.T === 0n) {
              expect(r.status).toBe('NO_DATA');
              continue;
            }
            if (!r.lower || !r.upper) throw new Error('Nonempty counts must have bounds');
            const outcomes: boolean[] = [];
            for (let x = 0n; x <= o; x++) {
              const possible = { numerator: e + x, denominator: r.T };
              expect(compare(possible, r.lower)).toBeGreaterThanOrEqual(0n);
              expect(compare(possible, r.upper)).toBeLessThanOrEqual(0n);
              outcomes.push(compare(possible, threshold) <= 0n);
              checked++;
            }
            expect(compare({ numerator: e, denominator: r.T }, r.lower)).toBe(0n);
            expect(compare({ numerator: e + o, denominator: r.T }, r.upper)).toBe(0n);
            expect(r.status).toBe(
              outcomes.every(Boolean)
                ? 'WITHIN_LIMIT'
                : outcomes.every((v) => !v)
                  ? 'EXCEEDS_LIMIT'
                  : 'INDETERMINATE',
            );
          }
    expect(checked).toBeGreaterThan(10000);
  });
});
describe('applicability and identity', () => {
  test.each([
    [
      'cumulative',
      'UNSUPPORTED_TEMPORALITY',
      (f: ReturnType<typeof fixture>) => {
        sum(f).aggregationTemporality = 2;
      },
    ],
    [
      'non-monotonic',
      'NON_MONOTONIC_SUM',
      (f: ReturnType<typeof fixture>) => {
        sum(f).isMonotonic = false;
      },
    ],
    [
      'negative',
      'NEGATIVE_COUNT',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints[0].asInt = '-1';
      },
    ],
    [
      'missing timestamp',
      'MISSING_TIMESTAMP',
      (f: ReturnType<typeof fixture>) => {
        delete (sum(f).dataPoints[0] as Partial<ReturnType<typeof sum>['dataPoints'][0]>)
          .startTimeUnixNano;
      },
    ],
    [
      'unequal overlap',
      'INCOMPATIBLE_INTERVALS',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints[1].startTimeUnixNano = '1500000000';
      },
    ],
    [
      'duplicate',
      'DUPLICATE_POINT',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints.push(structuredClone(sum(f).dataPoints[0]));
      },
    ],
    [
      'missing outcome',
      'MISSING_OUTCOME',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints[0].attributes = [];
      },
    ],
    [
      'non-boolean outcome',
      'NON_BOOLEAN_OUTCOME',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(sum(f).dataPoints[0], {
          attributes: [{ key: 'success', value: { stringValue: 'true' } }],
        });
      },
    ],
    [
      'string marker',
      'INVALID_OVERFLOW_MARKER',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(sum(f).dataPoints[2], {
          attributes: [{ key: 'otel.metric.overflow', value: { stringValue: 'true' } }],
        });
      },
    ],
    [
      'false marker',
      'INVALID_OVERFLOW_MARKER',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(sum(f).dataPoints[2], {
          attributes: [{ key: 'otel.metric.overflow', value: { boolValue: false } }],
        });
      },
    ],
    [
      'Guardian shape',
      'AMBIGUOUS_OVERFLOW',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints[2].attributes.push({ key: 'success', value: { boolValue: false } });
      },
    ],
    [
      'asDouble',
      'DOUBLE_COUNTER',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(sum(f).dataPoints[0], { asDouble: 900 });
      },
    ],
    [
      'flags',
      'UNSUPPORTED_FLAGS',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(sum(f).dataPoints[0], { flags: 1 });
      },
    ],
    [
      'overflow int64',
      'INTEGER_OUT_OF_RANGE',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints[0].asInt = '9223372036854775808';
      },
    ],
    [
      'duplicate attributes',
      'DUPLICATE_ATTRIBUTE',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints[0].attributes.push({ key: 'success', value: { boolValue: true } });
      },
    ],
    [
      'multiple AnyValue types',
      'INVALID_ATTRIBUTE',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(sum(f).dataPoints[0], {
          attributes: [{ key: 'success', value: { boolValue: true, stringValue: 'true' } }],
        });
      },
    ],
    [
      'no interval',
      'MISSING_INTERVAL',
      (f: ReturnType<typeof fixture>) => {
        sum(f).dataPoints = [];
      },
    ],
  ])('%s → %s', (_name, expected, mutate) => {
    const f = fixture();
    mutate(f);
    expect(code(f)).toBe(expected);
  });
  test.each(['gauge', 'histogram', 'summary', 'exponentialHistogram'])('unsupported %s', (type) => {
    const f = fixture();
    const m = f.resourceMetrics[0].scopeMetrics[0].metrics[0];
    Object.assign(m, { [type]: m.sum });
    delete (m as Partial<typeof m>).sum;
    expect(code(f)).toBe('UNSUPPORTED_TYPE');
  });
  test('unconfirmed provenance is unsupported', () => {
    expect(run(importFixture(fixture()).streams[0], { contractConfirmed: false })).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'PROVENANCE_NOT_CONFIRMED' },
    });
  });
  test('selected outcome cannot be marker', () => {
    expect(
      run(importFixture(fixture()).streams[0], { outcomeAttribute: 'otel.metric.overflow' }),
    ).toMatchObject({ diagnostic: { code: 'INVALID_OUTCOME_ATTRIBUTE' } });
  });
  test('different resources never merge', () => {
    const f = fixture();
    const r = structuredClone(f.resourceMetrics[0]);
    r.resource.attributes[0].value.stringValue = 'other';
    f.resourceMetrics.push(r);
    expect(importFixture(f).streams).toHaveLength(2);
  });
  test('different scopes never merge', () => {
    const f = fixture();
    const s = structuredClone(f.resourceMetrics[0].scopeMetrics[0]);
    s.scope.name = 'other';
    f.resourceMetrics[0].scopeMetrics.push(s);
    expect(importFixture(f).streams).toHaveLength(2);
  });
  test('attribute order does not change resource or measurement identity', () => {
    const f = fixture();
    f.resourceMetrics[0].resource.attributes.push({ key: 'zone', value: { stringValue: 'a' } });
    const r = structuredClone(f.resourceMetrics[0]);
    r.resource.attributes.reverse();
    f.resourceMetrics.push(r);
    const data = importFixture(f);
    expect(data.streams).toHaveLength(1);
    expect(run(data.streams[0])).toMatchObject({ diagnostic: { code: 'DUPLICATE_POINT' } });
  });
  test('conflicting definitions reject both streams', () => {
    const f = fixture();
    const m = structuredClone(f.resourceMetrics[0].scopeMetrics[0].metrics[0]);
    m.unit = '1';
    f.resourceMetrics[0].scopeMetrics[0].metrics.push(m);
    const data = importFixture(f);
    expect(data.streams).toHaveLength(2);
    for (const s of data.streams)
      expect(run(s)).toMatchObject({ diagnostic: { code: 'CONFLICTING_METRIC' } });
  });
  test('unsupported unrelated metric does not block', () => {
    const f = fixture();
    const m = structuredClone(f.resourceMetrics[0].scopeMetrics[0].metrics[0]);
    m.name = 'unrelated';
    m.sum.aggregationTemporality = 2;
    f.resourceMetrics[0].scopeMetrics[0].metrics.push(m);
    const data = importFixture(f);
    expect(run(data.streams[0]).status).toBe('INDETERMINATE');
    expect(run(data.streams[1]).status).toBe('UNSUPPORTED_INPUT');
  });
  test('adjacent full intervals select separately', () => {
    const f = fixture();
    const next = structuredClone(sum(f).dataPoints);
    for (const p of next) {
      p.startTimeUnixNano = '2000000000';
      p.timeUnixNano = '3000000000';
      p.asInt = '0';
    }
    sum(f).dataPoints.push(...next);
    const s = importFixture(f).streams[0];
    expect(s.intervals).toHaveLength(2);
    expect(run(s).status).toBe('INDETERMINATE');
    expect(run(s, { intervalId: s.intervals[1].id }).status).toBe('NO_DATA');
  });
  test('unknown fields are ignored', () => {
    const f = fixture();
    Object.assign(f, { future: { version: 123 } });
    Object.assign(sum(f).dataPoints[0], { future: true });
    expect(code(f)).toBe('INDETERMINATE');
  });
  test('conflicting JSON duplicate keys rejected', () => {
    expect(() => parseOtlp('{"resourceMetrics":[],"resourceMetrics":[{}]}')).toThrow();
  });
  test('strict integer tokens reject rounded fractional integers', () => {
    const text = JSON.stringify(fixture()).replace('"900"', '900.00000000000000001');
    expect(run(normalize(parseOtlp(text)).streams[0])).toMatchObject({
      diagnostic: { code: 'INVALID_INTEGER' },
    });
  });
  test('file size limited by UTF-8 bytes', () => {
    expect(() => parseOtlp(' '.repeat(MAX_FILE_BYTES + 1))).toThrow('5 MiB');
  });
  test('report replays exact point counts and calculation', () => {
    const s = importFixture(fixture()).streams[0];
    const settings = {
      intervalId: s.intervals[0].id,
      outcomeAttribute: 'success',
      errorValue: false,
      threshold: '1',
      contractConfirmed: true,
    };
    const result = analyze(s, settings);
    const report = JSON.parse(
      makeReport(s, settings, result, { name: 'demo', sha256: 'test', bytes: 100 }),
    );
    expect(report.result.lower).toEqual({ numerator: '1', denominator: '1000' });
    expect(
      report.result.points.reduce((n: bigint, p: { count: string }) => n + BigInt(p.count), 0n),
    ).toBe(1000n);
    expect(report.assumptions.structurallyProven).toBe(false);
    expect(report.witnesses.upper.overflowErrors).toBe('99');
  });
});

test('malformed repeat cannot silently remove selected counts', () => {
  const f = fixture();
  const m = structuredClone(f.resourceMetrics[0].scopeMetrics[0].metrics[0]);
  Object.assign(m.sum, { aggregationTemporality: { bad: true } });
  f.resourceMetrics[0].scopeMetrics[0].metrics.push(m);
  const d = importFixture(f);
  expect(run(d.streams[0])).toMatchObject({
    status: 'INVALID_INPUT',
    diagnostic: { code: 'INVALID_INTEGER' },
  });
});
test('scope and resource boolean attributes are not measurement outcomes', () => {
  const f = fixture();
  Object.assign(f.resourceMetrics[0].resource, {
    attributes: [{ key: 'success', value: { boolValue: true } }],
  });
  f.resourceMetrics[0].scopeMetrics[0].scope.name = 'success';
  f.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes = [];
  expect(code(f)).toBe('MISSING_OUTCOME');
});
test('same scope attributes in different order have the same identity', () => {
  const f = fixture();
  const scope = f.resourceMetrics[0].scopeMetrics[0];
  Object.assign(scope.scope, {
    attributes: [
      { key: 'x', value: { intValue: '1' } },
      { key: 'y', value: { boolValue: true } },
    ],
  });
  const duplicate = structuredClone(scope);
  Object.assign(duplicate.scope, {
    attributes: [
      { key: 'y', value: { boolValue: true } },
      { key: 'x', value: { intValue: 1 } },
    ],
  });
  f.resourceMetrics[0].scopeMetrics.push(duplicate);
  expect(importFixture(f).streams).toHaveLength(1);
  expect(code(f)).toBe('DUPLICATE_POINT');
});
test('duplicate measurement identities independent of attribute order', () => {
  const f = fixture();
  const point = sum(f).dataPoints[0];
  point.attributes.push({ key: 'route', value: { stringValue: '/' } });
  const dup = structuredClone(point);
  dup.attributes.reverse();
  sum(f).dataPoints.push(dup);
  expect(code(f)).toBe('DUPLICATE_POINT');
});
test('numeric wrapper lookalikes cannot forge asInt', () => {
  const f = fixture();
  Object.assign(sum(f).dataPoints[0], { asInt: { isLosslessNumber: true, value: '900' } });
  expect(code(f)).toBe('INVALID_INTEGER');
});
test('worker-cloned numeric points remain lossless', () => {
  const data = structuredClone(importFixture(fixture(900, 1, 99)));
  expect(run(data.streams[0])).toMatchObject({ K: 901n, O: 99n });
});
test('decimal-valued ordinary dimensions survive worker cloning', () => {
  const f = fixture();
  sum(f).dataPoints[0].attributes.push({ key: 'sample', value: { doubleValue: 1.25 } });
  const data = structuredClone(importFixture(f));
  expect(run(data.streams[0]).status).toBe('INDETERMINATE');
});
