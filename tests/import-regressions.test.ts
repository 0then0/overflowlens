import { describe, expect, test } from 'vitest';
import { normalize } from '../src/core/normalize';
import { attributes, canonical, parseOtlp } from '../src/core/parse';
import { fixture, importFixture, run } from './helpers';

const sum = (f: ReturnType<typeof fixture>) => f.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
const clonedImport = (raw: unknown) => structuredClone(importFixture(raw));

describe('semantic attribute identity', () => {
  test.each([
    ['YQ==', 'YQ'],
    ['/w==', '/w'],
    ['/w==', '_w=='],
    ['/w==', '_w'],
    ['', ''],
  ])('equivalent bytes %s and %s cannot inflate the denominator', (first, second) => {
    const f = fixture('99', '1', null);
    const points = sum(f).dataPoints;
    points[0].attributes.push({ key: 'id', value: { bytesValue: first } });
    const duplicate = structuredClone(points[0]);
    duplicate.attributes[1] = { key: 'id', value: { bytesValue: second } };
    points.push(duplicate);
    expect(run(clonedImport(f).streams[0], { threshold: '0.75' })).toMatchObject({
      status: 'INVALID_INPUT',
      diagnostic: { code: 'DUPLICATE_POINT' },
    });
  });

  test.each(['resource', 'scope'])('bytes encodings preserve %s identity', (container) => {
    const f = fixture();
    const original = f.resourceMetrics[0];
    const attrs = [{ key: 'id', value: { bytesValue: '/w==' } }];
    if (container === 'resource') Object.assign(original.resource, { attributes: attrs });
    else Object.assign(original.scopeMetrics[0].scope, { attributes: attrs });
    const duplicate = structuredClone(original);
    const alternate = [{ key: 'id', value: { bytesValue: '_w' } }];
    if (container === 'resource') Object.assign(duplicate.resource, { attributes: alternate });
    else Object.assign(duplicate.scopeMetrics[0].scope, { attributes: alternate });
    f.resourceMetrics.push(duplicate);
    const data = clonedImport(f);
    expect(data.streams).toHaveLength(1);
    expect(run(data.streams[0])).toMatchObject({ diagnostic: { code: 'DUPLICATE_POINT' } });
  });

  test.each(['%%%', 'Y', 'YQ=', 'YQ===', 'Y===', 'Y Q==', '/_=='])(
    'reject malformed base64 %s',
    (encoded) => {
      const f = fixture();
      sum(f).dataPoints[0].attributes.push({ key: 'id', value: { bytesValue: encoded } });
      expect(run(clonedImport(f).streams[0])).toMatchObject({
        status: 'INVALID_INPUT',
        diagnostic: { code: 'INVALID_ATTRIBUTE' },
      });
    },
  );

  test.each(['1.25', '1.25e0', '-0', '1e2'])(
    'quoted double %s survives Worker transfer with numeric identity',
    (quoted) => {
      const f = fixture('99', '1', null);
      sum(f).dataPoints[0].attributes.push({ key: 'sample.rate', value: { doubleValue: quoted } });
      expect(run(clonedImport(f).streams[0])).toMatchObject({
        status: 'WITHIN_LIMIT',
        K: 100n,
        E: 1n,
      });
      const parsed = (value: unknown) =>
        attributes(
          parseOtlp(JSON.stringify([{ key: 'sample.rate', value: { doubleValue: value } }])),
          'attributes',
        );
      expect(canonical(parsed(quoted))).toEqual(canonical(parsed(Number(quoted))));
    },
  );

  test.each(['', ' ', '1.2x', '0x10', 'Infinity', 'NaN', '1e309'])(
    'reject malformed or nonfinite quoted double %s',
    (value) => {
      const f = fixture();
      sum(f).dataPoints[0].attributes.push({ key: 'sample.rate', value: { doubleValue: value } });
      expect(run(clonedImport(f).streams[0])).toMatchObject({
        diagnostic: { code: 'INVALID_ATTRIBUTE' },
      });
    },
  );

  test('numeric and quoted double dimensions identify a duplicate point', () => {
    const f = fixture();
    const p = sum(f).dataPoints[0];
    p.attributes.push({ key: 'sample.rate', value: { doubleValue: 1.25 } });
    const duplicate = structuredClone(p);
    duplicate.attributes[1] = { key: 'sample.rate', value: { doubleValue: '1.25' } };
    sum(f).dataPoints.push(duplicate);
    expect(run(clonedImport(f).streams[0])).toMatchObject({
      diagnostic: { code: 'DUPLICATE_POINT' },
    });
  });
});

describe('unknown JSON fields cannot supply inherited metadata', () => {
  test('a parser number used as __proto__ cannot forge a numeric token', () => {
    const text = JSON.stringify(fixture()).replace(
      '"asInt":"900"',
      '"asInt":{"__proto__":900,"value":"900"}',
    );
    expect(run(structuredClone(normalize(parseOtlp(text))).streams[0])).toMatchObject({
      diagnostic: { code: 'INVALID_INTEGER' },
    });
  });

  test('inherited metric type is not a real Sum field', () => {
    const f = fixture();
    const m = f.resourceMetrics[0].scopeMetrics[0].metrics[0];
    const { sum: data, ...definition } = m;
    const raw = { ...definition, ['__proto__']: { sum: data } };
    Object.assign(f.resourceMetrics[0].scopeMetrics[0], { metrics: [raw] });
    expect(run(clonedImport(f).streams[0])).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'UNSUPPORTED_TYPE' },
    });
  });

  test.each([
    ['"isMonotonic":true,"aggregationTemporality":1,', 'UNSUPPORTED_TEMPORALITY'],
    ['"isMonotonic":true,', 'NON_MONOTONIC_SUM'],
  ])('reject inherited Sum definition (%s)', (removed, code) => {
    const text = JSON.stringify(fixture()).replace(
      removed,
      '"__proto__":{"isMonotonic":true,"aggregationTemporality":1},',
    );
    const data = structuredClone(normalize(parseOtlp(text)));
    expect(run(data.streams[0])).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code },
    });
  });

  test('unknown prototype fields cannot override real unsupported metadata', () => {
    const text = JSON.stringify(fixture()).replace(
      '"isMonotonic":true,',
      '"isMonotonic":false,"__proto__":{"isMonotonic":true},"futureField":123,',
    );
    expect(run(structuredClone(normalize(parseOtlp(text))).streams[0])).toMatchObject({
      diagnostic: { code: 'NON_MONOTONIC_SUM' },
    });
  });

  test('prototype fields are ignored without losing exact numeric tokens', () => {
    const text = JSON.stringify(fixture('9007199254740993', '1', null))
      .replace('"9007199254740993"', '9007199254740993')
      .replace('"resourceMetrics":', '"__proto__":{"futureField":true},"resourceMetrics":');
    const data = structuredClone(normalize(parseOtlp(text)));
    expect(run(data.streams[0])).toMatchObject({ K: 9007199254740994n });
  });

  test('reserved object names remain valid measurement attribute keys', () => {
    const f = fixture();
    sum(f).dataPoints[0].attributes.push({ key: '__proto__', value: { boolValue: true } });
    expect(run(clonedImport(f).streams[0]).status).toBe('INDETERMINATE');
  });
});

describe('container errors cannot produce a partial-data verdict', () => {
  test.each(['scope', 'resource'])(
    'malformed repeated %s blocks regardless of order',
    (container) => {
      for (const first of [false, true]) {
        const f = fixture('99', '1', null);
        const repeated = structuredClone(f.resourceMetrics[0]);
        const points = repeated.scopeMetrics[0].metrics[0].sum.dataPoints;
        points.splice(0, 1);
        points[0].asInt = '99';
        points[0].attributes.push({ key: 'request.id', value: { stringValue: 'second' } });
        if (container === 'resource') {
          Object.assign(repeated.resource, { droppedAttributesCount: 'bad' });
          if (first) f.resourceMetrics.unshift(repeated);
          else f.resourceMetrics.push(repeated);
        } else {
          const scope = repeated.scopeMetrics[0];
          Object.assign(scope.scope, { droppedAttributesCount: 'bad' });
          if (first) f.resourceMetrics[0].scopeMetrics.unshift(scope);
          else f.resourceMetrics[0].scopeMetrics.push(scope);
        }
        const data = clonedImport(f);
        expect(data.diagnostics).toEqual([expect.objectContaining({ code: 'INVALID_INTEGER' })]);
        expect(run(data.streams[0], { threshold: '2' })).toMatchObject({
          status: 'INVALID_INPUT',
          diagnostic: { code: 'INVALID_INTEGER' },
        });
      }
    },
  );

  test.each(['scope', 'resource'])(
    'invalid unrelated %s leaves the selected stream usable',
    (container) => {
      const f = fixture('99', '1', null);
      const unrelated = structuredClone(f.resourceMetrics[0]);
      if (container === 'resource') {
        unrelated.resource.attributes[0].value.stringValue = 'other-service';
        Object.assign(unrelated.resource, { droppedAttributesCount: 'bad' });
        f.resourceMetrics.push(unrelated);
      } else {
        const scope = unrelated.scopeMetrics[0];
        scope.scope.name = 'other-scope';
        Object.assign(scope.scope, { droppedAttributesCount: 'bad' });
        f.resourceMetrics[0].scopeMetrics.push(scope);
      }
      const data = clonedImport(f);
      expect(data.diagnostics).toHaveLength(1);
      expect(run(data.streams[0])).toMatchObject({ status: 'WITHIN_LIMIT', K: 100n, E: 1n });
    },
  );

  test.each(['scope', 'resource'])(
    'unidentifiable %s cannot silently discard related data',
    (container) => {
      const f = fixture();
      const malformed = structuredClone(f.resourceMetrics[0]);
      if (container === 'resource') {
        Object.assign(malformed.resource, { attributes: 'bad' });
        f.resourceMetrics.push(malformed);
      } else {
        const scope = malformed.scopeMetrics[0];
        Object.assign(scope.scope, { attributes: 'bad' });
        f.resourceMetrics[0].scopeMetrics.push(scope);
      }
      expect(run(clonedImport(f).streams[0])).toMatchObject({
        status: 'INVALID_INPUT',
        diagnostic: { code: 'INVALID_STRUCTURE' },
      });
    },
  );
});
