import { array, attributes, canonical, integer, materializeNumbers, object, string } from './parse';
import {
  type Diagnostic,
  diagnostic,
  fail,
  type Identity,
  type ImportData,
  type Stream,
} from './types';

const TYPES = ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary'];
export function normalize(raw: unknown): ImportData {
  const root = object(raw, 'root');
  if (!Object.hasOwn(root, 'resourceMetrics'))
    fail('NOT_OTLP_METRICS', 'Expected an ExportMetricsServiceRequest with resourceMetrics.');
  const streams = new Map<string, Stream>();
  const families = new Map<string, Set<string>>();
  const familyErrors = new Map<string, ImportData['diagnostics']>();
  const intervalMaps = new Map<string, Map<string, Stream['intervals'][number]>>();
  const diagnostics: ImportData['diagnostics'] = [];
  const containerErrors: { resource?: string; scope?: string; diagnostic: Diagnostic }[] = [];
  for (const [ri, resourceRaw] of array(root.resourceMetrics, 'resourceMetrics').entries()) {
    const rp = `resourceMetrics[${ri}]`;
    let resourceKey: string | undefined;
    try {
      const rm = object(resourceRaw, rp),
        resource = object(rm.resource ?? {}, `${rp}.resource`);
      const resourceAttrs = attributes(resource.attributes, `${rp}.resource.attributes`);
      resourceKey = canonical({
        attributes: resourceAttrs,
        schemaUrl: string(rm.schemaUrl, rp),
      });
      checkDropped(resource, rp);
      for (const [si, scopeRaw] of array(rm.scopeMetrics, `${rp}.scopeMetrics`).entries()) {
        const sp = `${rp}.scopeMetrics[${si}]`;
        let scopeKey: string | undefined;
        try {
          const sm = object(scopeRaw, sp),
            scope = object(sm.scope ?? {}, `${sp}.scope`);
          const scopeIdentity = {
            name: string(scope.name, sp),
            version: string(scope.version, sp),
            attributes: attributes(scope.attributes, `${sp}.scope.attributes`),
          };
          scopeKey = canonical({ ...scopeIdentity, schemaUrl: string(sm.schemaUrl, sp) });
          checkDropped(scope, sp);
          for (const [mi, metricRaw] of array(sm.metrics, `${sp}.metrics`).entries()) {
            const mp = `${sp}.metrics[${mi}]`;
            let base: string | undefined;
            try {
              const m = object(metricRaw, mp);
              const name = string(m.name, `${mp}.name`);
              base = canonical({
                resource: resourceAttrs,
                resourceSchemaUrl: string(rm.schemaUrl, rp),
                scope: scopeIdentity,
                scopeSchemaUrl: string(sm.schemaUrl, sp),
                name,
              });
              const present = TYPES.filter((t) => m[t] !== undefined && m[t] !== null);
              const type = present.length === 1 ? present[0] : 'unknown';
              const data = type === 'unknown' ? {} : object(m[type], `${mp}.${type}`);
              const temporality =
                type === 'sum' ? enumTemporality(data.aggregationTemporality, mp) : 'N/A';
              const identity: Identity = {
                resource: resourceAttrs,
                resourceSchemaUrl: string(rm.schemaUrl, rp),
                scope: scopeIdentity,
                scopeSchemaUrl: string(sm.schemaUrl, sp),
                name,
                type,
                unit: string(m.unit, `${mp}.unit`),
                temporality,
                monotonic: data.isMonotonic === true,
              };
              if (!identity.name)
                fail('MISSING_METRIC_NAME', 'A metric needs a nonempty name.', mp);
              const id = canonical(identity);
              const family = families.get(base) ?? new Set<string>();
              family.add(id);
              families.set(base, family);
              let stream = streams.get(id);
              if (!stream) {
                stream = { id, identity, intervals: [], snapshots: [], diagnostics: [] };
                streams.set(id, stream);
                intervalMaps.set(id, new Map());
              }
              const intervals = intervalMaps.get(id);
              if (!intervals) throw new Error('Missing interval index for metric stream');
              try {
                if (present.length > 1)
                  fail('MULTIPLE_METRIC_TYPES', 'Metric has multiple data types.', mp);
                if (type !== 'sum')
                  fail(
                    'UNSUPPORTED_TYPE',
                    'Only monotonic integer Sum request counters are supported.',
                    mp,
                    'UNSUPPORTED_INPUT',
                  );
                if (temporality !== 'DELTA' && temporality !== 'CUMULATIVE')
                  fail(
                    'UNSUPPORTED_TEMPORALITY',
                    'Select delta (1) or cumulative (2) temporality.',
                    mp,
                    'UNSUPPORTED_INPUT',
                  );
                if (data.isMonotonic != null && typeof data.isMonotonic !== 'boolean')
                  fail('INVALID_MONOTONICITY', 'isMonotonic must be boolean.', mp);
                if (!identity.monotonic)
                  fail('NON_MONOTONIC_SUM', 'The Sum must be monotonic.', mp, 'UNSUPPORTED_INPUT');
                const points = array(data.dataPoints, `${mp}.sum.dataPoints`);
                if (points.length === 0)
                  fail(
                    'MISSING_INTERVAL',
                    'There are no timestamped points to identify a complete interval. A timestamped zero counter is supported.',
                    mp,
                  );
                for (const [pi, pointRaw] of points.entries()) {
                  const pp = `${mp}.sum.dataPoints[${pi}]`,
                    point = object(pointRaw, pp);
                  if (point.startTimeUnixNano == null || point.timeUnixNano == null)
                    fail('MISSING_TIMESTAMP', 'Both interval timestamps are required.', pp);
                  const start = integer(point.startTimeUnixNano, `${pp}.startTimeUnixNano`, true),
                    end = integer(point.timeUnixNano, `${pp}.timeUnixNano`, true);
                  if (start <= 0n || end <= start)
                    fail('INVALID_INTERVAL', 'Require 0 < startTimeUnixNano < timeUnixNano.', pp);
                  if (point.asDouble != null)
                    fail(
                      'DOUBLE_COUNTER',
                      'asDouble is not supported. A request counter must use asInt.',
                      pp,
                      'UNSUPPORTED_INPUT',
                    );
                  if (point.asInt == null)
                    fail('MISSING_COUNT', 'The point has no asInt count.', pp);
                  if (integer(point.asInt, `${pp}.asInt`) < 0n)
                    fail('NEGATIVE_COUNT', 'A request counter must be nonnegative.', pp);
                  if (point.flags != null) integer(point.flags, `${pp}.flags`, true, 32);
                  if (temporality === 'CUMULATIVE') {
                    let snapshot = stream.snapshots[0];
                    if (snapshot && snapshot.end !== String(end))
                      fail(
                        'INCONSISTENT_TIMESTAMPS',
                        'All points in the selected cumulative export must share one collection timestamp. Selecting a subset cannot establish completeness.',
                        pp,
                        'UNSUPPORTED_INPUT',
                      );
                    if (!snapshot) {
                      snapshot = { id: String(end), end: String(end), points: [] };
                      stream.snapshots.push(snapshot);
                    }
                    snapshot.points.push(materializeNumbers(point) as typeof point);
                    continue;
                  }
                  const intervalId = `${start}:${end}`;
                  let interval = intervals.get(intervalId);
                  if (!interval) {
                    interval = {
                      id: intervalId,
                      start: String(start),
                      end: String(end),
                      points: [],
                    };
                    stream.intervals.push(interval);
                    intervals.set(intervalId, interval);
                  }
                  interval.points.push(materializeNumbers(point) as typeof point);
                }
              } catch (error) {
                stream.diagnostics.push(diagnostic(error));
              }
            } catch (error) {
              const d = diagnostic(error);
              diagnostics.push(d);
              if (base) {
                const errors = familyErrors.get(base) ?? [];
                errors.push(d);
                familyErrors.set(base, errors);
              }
            }
          }
        } catch (error) {
          const d = diagnostic(error);
          diagnostics.push(d);
          containerErrors.push({ resource: resourceKey, scope: scopeKey, diagnostic: d });
        }
      }
    } catch (error) {
      const d = diagnostic(error);
      diagnostics.push(d);
      containerErrors.push({ resource: resourceKey, diagnostic: d });
    }
  }
  for (const [base, errors] of familyErrors)
    for (const id of families.get(base) ?? []) streams.get(id)?.diagnostics.push(...errors);
  for (const ids of families.values())
    if (ids.size > 1)
      for (const id of ids)
        streams.get(id)?.diagnostics.push({
          status: 'INVALID_INPUT',
          code: 'CONFLICTING_METRIC',
          message:
            'The same Resource, scope and metric name have conflicting type, unit, temporality or monotonicity definitions.',
        });
  for (const stream of streams.values()) {
    const resourceKey = canonical({
      attributes: stream.identity.resource,
      schemaUrl: stream.identity.resourceSchemaUrl,
    });
    const scopeKey = canonical({
      ...stream.identity.scope,
      schemaUrl: stream.identity.scopeSchemaUrl,
    });
    for (const error of containerErrors)
      if (
        (error.resource === undefined || error.resource === resourceKey) &&
        (error.scope === undefined || error.scope === scopeKey)
      )
        stream.diagnostics.push(error.diagnostic);
    stream.intervals.sort((a, b) => (BigInt(a.start) < BigInt(b.start) ? -1 : 1));
    for (let i = 1; i < stream.intervals.length; i++)
      if (BigInt(stream.intervals[i].start) < BigInt(stream.intervals[i - 1].end))
        stream.diagnostics.push({
          status: 'INVALID_INPUT',
          code: 'INCOMPATIBLE_INTERVALS',
          message:
            'Points have overlapping but unequal interval boundaries. They cannot represent separate complete collection intervals.',
        });
  }
  return { streams: [...streams.values()], diagnostics };
}
function enumTemporality(v: unknown, path: string): string {
  if (v === undefined || v === null) return 'UNSPECIFIED';
  // OTLP JSON requires numeric enum values, unlike generic protobuf JSON.
  if (typeof v === 'string') return 'INVALID_ENUM';
  const n = integer(v, path, true, 32);
  return n === 1n ? 'DELTA' : n === 2n ? 'CUMULATIVE' : 'UNSPECIFIED';
}
function checkDropped(v: Record<string, unknown>, path: string) {
  if (v.droppedAttributesCount != null && integer(v.droppedAttributesCount, path, true, 32) !== 0n)
    fail(
      'DROPPED_IDENTITY_ATTRIBUTES',
      'Resource or scope attributes were dropped; stream identity cannot be established conservatively.',
      path,
    );
}
