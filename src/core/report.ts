import type { Settings } from './analyze';
import { type CumulativeSettings, type MatchedPoint, pairCumulative } from './cumulative';
import type { HttpSettings } from './http';
import { type HttpCumulativeSettings, pairHttpCumulative } from './httpCumulative';
import { canonical } from './parse';
import {
  ROUTE_CHECKS,
  type RouteSlowAnalysis,
  type RouteSlowPreparation,
  type RouteSlowSettings,
} from './routeSlow';
import {
  type Analysis,
  CONTRACT,
  CUMULATIVE_CONTRACT,
  HTTP_CONTRACT,
  HTTP_CRITERION,
  HTTP_CUMULATIVE_CONTRACT,
  HTTP_METRIC,
  HTTP_ROUTE_ATTRIBUTE,
  HTTP_ROUTE_CONTRACT,
  HTTP_STATUS_ATTRIBUTE,
  type Stream,
} from './types';
export type Source = { name: string; sha256: string; bytes: number };
export function makeReport(stream: Stream, settings: Settings, result: Analysis, source: Source) {
  const interval = stream.intervals.find((i) => i.id === settings.intervalId);
  const report = {
    reportVersion: '1',
    application: { name: 'OverflowLens', version: '0.4.0' },
    source,
    identity: stream.identity,
    interval: interval ? { startTimeUnixNano: interval.start, timeUnixNano: interval.end } : null,
    settings,
    assumptions: {
      contract: CONTRACT,
      userConfirmed: settings.contractConfirmed,
      structurallyProven: false,
    },
    model: {
      K: 'sum of ordinary points',
      E: 'sum of ordinary error points',
      O: 'SDK overflow count',
      T: 'K + O',
      lower: 'E / T',
      upper: '(E + O) / T',
      within: 'upper <= threshold',
      exceeds: 'lower > threshold',
      equalityAllowed: true,
    },
    result,
    witnesses:
      'lower' in result && result.T > 0n
        ? {
            lower: { overflowErrors: '0', overflowSuccesses: result.O.toString() },
            upper: { overflowErrors: result.O.toString(), overflowSuccesses: '0' },
          }
        : null,
    limitations: [
      'One imported interval, not a full SLO assessment.',
      'The file cannot prove completeness, synchronous instrumentation or pre-transformation SDK provenance.',
      'Bounds describe possible allocations, not a confidence interval or recovered attributes.',
    ],
  };
  return JSON.stringify(
    report,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
}

export function makeCumulativeReport(
  before: Stream,
  after: Stream,
  settings: CumulativeSettings,
  result: Analysis,
  sources: { before: Source; after: Source },
) {
  const pair = pairCumulative(before, after, settings);
  const b = before.snapshots.find((s) => s.id === settings.beforeSnapshotId);
  const a = after.snapshots.find((s) => s.id === settings.afterSnapshotId);
  // Canonicalize key order as well as matched-point order for repeatable evidence.
  return JSON.stringify(
    JSON.parse(
      canonical({
        reportVersion: '2',
        application: { name: 'OverflowLens', version: '0.4.0' },
        mode: 'cumulative',
        sources,
        identity: before.identity,
        selectedInputs: {
          before: {
            identity: before.identity,
            snapshotId: settings.beforeSnapshotId,
            timeUnixNano: b?.end ?? null,
          },
          after: {
            identity: after.identity,
            snapshotId: settings.afterSnapshotId,
            timeUnixNano: a?.end ?? null,
          },
        },
        window: b && a ? { startTimeUnixNano: b.end, timeUnixNano: a.end } : null,
        settings,
        assumptions: {
          contract: CUMULATIVE_CONTRACT,
          userConfirmed: settings.contractConfirmed,
          structurallyProven: false,
        },
        applicability:
          pair.status === 'APPLICABLE'
            ? {
                status: pair.status,
                checks: pair.evidence.checks,
                matchedPointCount: pair.evidence.points.length,
              }
            : pair,
        model: {
          increment: 'count(after) - count(before), for each matched point',
          K: 'sum of ordinary increments',
          E: 'sum of ordinary error increments',
          O: 'SDK overflow increment',
          T: 'K + O',
          lower: 'E / T',
          upper: '(E + O) / T',
          within: 'upper <= threshold',
          exceeds: 'lower > threshold',
          equalityAllowed: true,
        },
        result: JSON.parse(
          JSON.stringify({ ...result, evidence: undefined }, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ),
        witnesses:
          'K' in result && result.T > 0n
            ? {
                lower: { overflowErrors: '0', overflowSuccesses: result.O.toString() },
                upper: { overflowErrors: result.O.toString(), overflowSuccesses: '0' },
              }
            : null,
        limitations: [
          'One saved cumulative window, identical measurement identities only; no reset handling.',
          'Hashes identify bytes, not authenticity, completeness or continuous source history.',
          'Endpoint witnesses allocate window overflow increments; exemplars cannot recover all outcomes.',
        ],
      }),
    ),
    null,
    2,
  );
}

export function makeHttpReport(
  stream: Stream,
  settings: HttpSettings,
  result: Analysis,
  source: Source,
) {
  const interval = stream.intervals.find((i) => i.id === settings.intervalId);
  return JSON.stringify(
    {
      reportVersion: '3',
      application: { name: 'OverflowLens', version: '0.4.0' },
      mode: 'http-5xx-histogram',
      source,
      identity: stream.identity,
      inputMetric: {
        name: stream.identity.name,
        type: 'Histogram',
        buckets: 'explicit',
        temporality: stream.identity.temporality,
        unit: stream.identity.unit,
        expectedName: HTTP_METRIC,
        countMeaning: 'count of each datapoint is the number of completed HTTP requests',
      },
      classification: {
        criterion: HTTP_CRITERION,
        attribute: HTTP_STATUS_ATTRIBUTE,
        errorStatusCodes: '500-599',
        otherStatusCodes: '100-499',
        ordinaryPoints: 'integer status code required; missing, invalid or contradictory refuses',
        overflowPoints: 'exactly one attribute, otel.metric.overflow = true; counted separately',
      },
      interval: interval ? { startTimeUnixNano: interval.start, timeUnixNano: interval.end } : null,
      settings,
      assumptions: {
        contract: HTTP_CONTRACT,
        userConfirmed: settings.contractConfirmed,
        conditions: [
          'Each histogram observation corresponds to one completed HTTP request.',
          'Ordinary points retain the correct http.response.status_code.',
          'Downstream processing did not change counts or attribution.',
        ],
        nameMatchProvesConditions: false,
        structurallyProven: false,
      },
      model: {
        K: 'sum of count over ordinary points',
        E: 'sum of count over ordinary points with status code 500-599',
        O: 'sum of count over the SDK overflow point',
        T: 'K + O',
        lower: 'E / T',
        upper: '(E + O) / T',
        within: 'upper <= threshold',
        exceeds: 'lower > threshold',
        equalityAllowed: true,
      },
      result,
      witnesses:
        'lower' in result && result.T > 0n
          ? {
              lower: { overflowServerErrors: '0', overflowOtherResponses: result.O.toString() },
              upper: { overflowServerErrors: result.O.toString(), overflowOtherResponses: '0' },
            }
          : null,
      limitations: [
        'One imported delta interval, not a full SLO assessment.',
        'The file cannot prove completeness, request semantics, status attribution or pre-transformation SDK provenance.',
        'Latency, routes and bucket contents are not analyzed. Bounds describe possible allocations, not a confidence interval.',
      ],
    },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
}

export const HTTP_CUMULATIVE_CONDITIONS = [
  'Both exports are complete and come from one continuous source history; no reset occurred inside the window.',
  'Each histogram observation corresponds to one completed HTTP request.',
  'Ordinary points retain the correct http.response.status_code.',
  'Downstream processing changed neither counts nor attribution.',
  'The overflow marker has genuine SDK overflow semantics, with stable ordinary attribution across collections.',
];

// Schema v4: the cumulative HTTP 5xx window. Schemas v1 to v3 are unchanged.
export function makeHttpCumulativeReport(
  before: Stream,
  after: Stream,
  settings: HttpCumulativeSettings,
  result: Analysis,
  sources: { before: Source; after: Source },
) {
  const pair = pairHttpCumulative(before, after, settings);
  const b = before.snapshots.find((s) => s.id === settings.beforeSnapshotId);
  const a = after.snapshots.find((s) => s.id === settings.afterSnapshotId);
  const sum = (key: 'beforeCount' | 'afterCount' | 'count', pick: (p: MatchedPoint) => boolean) =>
    pair.status === 'APPLICABLE'
      ? pair.evidence.points
          .filter(pick)
          .reduce((n, p) => n + BigInt(p[key]), 0n)
          .toString()
      : null;
  const boundary = (key: 'beforeCount' | 'afterCount' | 'count') => ({
    knownRequests: sum(key, (p) => !p.overflow),
    knownServerErrors: sum(key, (p) => p.responseClass === 'server_error'),
    overflow: sum(key, (p) => p.overflow),
    total: sum(key, () => true),
  });
  const plain = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  // Canonicalize key order as well as matched-point order for repeatable evidence.
  return JSON.stringify(
    JSON.parse(
      canonical({
        reportVersion: '4',
        application: { name: 'OverflowLens', version: '0.4.0' },
        mode: 'http-5xx-histogram-cumulative',
        sources,
        identity: before.identity,
        selectedInputs: {
          before: {
            identity: before.identity,
            snapshotId: settings.beforeSnapshotId,
            timeUnixNano: b?.end ?? null,
          },
          after: {
            identity: after.identity,
            snapshotId: settings.afterSnapshotId,
            timeUnixNano: a?.end ?? null,
          },
        },
        inputMetric: {
          name: before.identity.name,
          type: 'Histogram',
          buckets: 'explicit',
          temporality: before.identity.temporality,
          unit: before.identity.unit,
          expectedName: HTTP_METRIC,
          countMeaning: 'count of each datapoint is the number of completed HTTP requests',
          usedFields: 'count, attributes, startTimeUnixNano, timeUnixNano',
          notUsed: 'sum, min, max, exemplars and bucket contents are validated but never estimated',
        },
        classification: {
          criterion: HTTP_CRITERION,
          attribute: HTTP_STATUS_ATTRIBUTE,
          errorStatusCodes: '500-599',
          otherStatusCodes: '100-499',
          ordinaryPoints: 'integer status code required; missing, invalid or contradictory refuses',
          overflowPoints: 'exactly one attribute, otel.metric.overflow = true; counted separately',
        },
        window: b && a ? { startTimeUnixNano: b.end, timeUnixNano: a.end } : null,
        settings,
        assumptions: {
          contract: HTTP_CUMULATIVE_CONTRACT,
          userConfirmed: settings.contractConfirmed,
          conditions: HTTP_CUMULATIVE_CONDITIONS,
          nameMatchProvesConditions: false,
          structurallyProven: false,
        },
        applicability:
          pair.status === 'APPLICABLE'
            ? {
                status: pair.status,
                checks: pair.evidence.checks,
                matchedPointCount: pair.evidence.points.length,
              }
            : plain(pair),
        // Counts accompany a verdict only; an unconfirmed or invalid request exports none.
        counts:
          pair.status === 'APPLICABLE' && 'K' in result
            ? {
                atBeforeBoundary: boundary('beforeCount'),
                atAfterBoundary: boundary('afterCount'),
                window: boundary('count'),
              }
            : null,
        model: {
          increment: 'count(after) - count(before), for each matched point',
          K: 'sum of increments over ordinary points',
          E: 'sum of increments over ordinary points with status code 500-599',
          O: 'sum of increments over the SDK overflow point',
          T: 'K + O',
          lower: 'E / T',
          upper: '(E + O) / T',
          within: 'upper <= threshold',
          exceeds: 'lower > threshold',
          equalityAllowed: true,
        },
        result: plain({ ...result, evidence: undefined }),
        witnesses:
          'K' in result && result.T > 0n
            ? {
                lower: { overflowServerErrors: '0', overflowOtherResponses: result.O.toString() },
                upper: { overflowServerErrors: result.O.toString(), overflowOtherResponses: '0' },
              }
            : null,
        limitations: [
          'One saved cumulative window of explicit-bucket counts, identical measurement identities only; no reset handling.',
          'Hashes identify bytes, not authenticity, completeness or continuous source history.',
          'Latency, routes and bucket contents are not analyzed. Bounds describe possible allocations, not a confidence interval.',
          'Endpoint witnesses allocate window overflow increments; exemplars cannot recover all statuses.',
        ],
      }),
    ),
    null,
    2,
  );
}

export const HTTP_ROUTE_CONDITIONS = [
  'The interval is complete: no point of the selected stream was dropped before this export.',
  'Each histogram observation corresponds to exactly one completed HTTP request.',
  'The recorded duration and the http.route of every request are correct.',
  'The overflow point has genuine SDK cardinality overflow semantics.',
  'Downstream processing changed neither counts, buckets nor attribution.',
];

// Schema v5: the slow-request share of one route in a delta duration histogram.
// Schemas v1 to v4 are unchanged.
export function makeRouteSlowReport(
  stream: Stream,
  settings: RouteSlowSettings,
  prepared: RouteSlowPreparation,
  result: RouteSlowAnalysis,
  source: Source,
) {
  const interval = stream.intervals.find((i) => i.id === settings.intervalId);
  const counted = 'K' in result;
  const bounded = counted && result.lower !== null;
  const plain = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  return JSON.stringify(
    JSON.parse(
      canonical({
        reportVersion: '5',
        application: { name: 'OverflowLens', version: '0.4.0' },
        mode: 'http-route-slow-share-histogram',
        source,
        identity: stream.identity,
        inputMetric: {
          name: stream.identity.name,
          type: 'Histogram',
          buckets: 'explicit',
          temporality: stream.identity.temporality,
          unit: stream.identity.unit,
          expectedName: HTTP_METRIC,
          expectedUnit: 's',
          countMeaning: 'count of each datapoint is the number of completed HTTP requests',
          usedFields: 'count, bucketCounts, explicitBounds, attributes',
          notUsed:
            'sum, min, max and exemplars are validated but never used to reconstruct buckets',
        },
        selection: {
          route: { attribute: HTTP_ROUTE_ATTRIBUTE, value: settings.route, match: 'exact string' },
          durationThreshold: {
            seconds: settings.durationSeconds,
            unit: 's',
            slow: 'duration strictly greater than the threshold',
            fast: 'duration less than or equal to the threshold (bucket upper bounds are inclusive)',
            boundary: 'must be an exact explicit bound; never interpolated or rounded',
          },
          maximumSlowShare: { percent: settings.maxSlowPercent },
        },
        interval: interval
          ? { startTimeUnixNano: interval.start, timeUnixNano: interval.end }
          : null,
        settings,
        assumptions: {
          contract: HTTP_ROUTE_CONTRACT,
          userConfirmed: settings.contractConfirmed,
          conditions: HTTP_ROUTE_CONDITIONS,
          nameMatchProvesConditions: false,
          structurallyProven: false,
        },
        applicability:
          prepared.status === 'APPLICABLE'
            ? { status: prepared.status, checks: ROUTE_CHECKS }
            : plain(prepared),
        // Counts accompany a verdict only; an unconfirmed or invalid request exports none.
        counts: counted
          ? plain({
              K: result.K,
              E: result.E,
              F: result.F,
              S: result.S,
              otherRoutesKnown: result.other,
              meaning: {
                K: 'requests of the selected route among ordinary points',
                E: 'requests of the selected route slower than the threshold among ordinary points',
                F: 'SDK overflow observations not slower than the threshold; their route is unknown',
                S: 'SDK overflow observations slower than the threshold; their route is unknown',
                otherRoutesKnown:
                  'ordinary observations of other routes; never part of the denominator',
              },
            })
          : null,
        model: {
          lower: 'E / (K + F)',
          upper: '(E + S) / (K + S)',
          within: 'upper <= maximum slow share',
          exceeds: 'lower > maximum slow share',
          equalityAllowed: true,
          noConfirmedObservations:
            'K = 0: the data allow the route to have had no requests. No share, bound or verdict is reported.',
          definedFor: 'K > 0',
        },
        unknownAttribution: {
          explanation:
            'SDK overflow replaces the measurement attributes, including http.route, with otel.metric.overflow = true. Which overflow observations belong to the selected route is unknown. The histogram buckets still separate fast from slow overflow observations, so the route can own any number from 0 to F of the fast and from 0 to S of the slow ones; the rest belong to other routes.',
          overflowAttributes: 'otel.metric.overflow = true',
        },
        result: plain({ ...result, points: undefined }),
        points: counted ? plain(result.points) : null,
        witnesses: bounded
          ? {
              lower: {
                overflowFastOfSelectedRoute: result.F.toString(),
                overflowSlowOfSelectedRoute: '0',
              },
              upper: {
                overflowFastOfSelectedRoute: '0',
                overflowSlowOfSelectedRoute: result.S.toString(),
              },
            }
          : null,
        limitations: [
          'One imported delta interval, not a full SLO assessment.',
          'The file cannot prove completeness, request semantics, route or duration correctness, or pre-transformation SDK provenance. Data lost before export cannot be detected.',
          'Bounds describe possible allocations of the lost route attribution, not a confidence interval. Durations are not interpolated within buckets.',
          'With no confirmed observations of the selected route, overflow may contain requests of that route, but the data cannot show that any exist.',
        ],
      }),
    ),
    null,
    2,
  );
}
