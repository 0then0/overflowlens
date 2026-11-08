import { overflowShape } from './analyze';
import { compare, thresholdPercent } from './calculate';
import { readHistogramPoint } from './histogram';
import { attributes, canonical } from './parse';
import {
  type Attributes,
  type Diagnostic,
  diagnostic,
  fail,
  HTTP_DURATION_UNIT,
  HTTP_METRIC,
  HTTP_ROUTE_ATTRIBUTE,
  type Rational,
  type Stream,
} from './types';

// Share of slow requests of one exact http.route in a delta http.server.request.duration
// histogram after SDK overflow. The overflow keeps its bucket distribution but loses the
// route, so its fast and slow observations are split by the chosen duration boundary and
// the route's share is bounded over every possible assignment of the lost attribution.
//
// Slow means strictly greater than the duration boundary. An observation equal to the
// boundary lies in the bucket whose inclusive upper bound it is, so it counts as fast.

export type RouteSlowSelection = { intervalId: string; route: string; durationSeconds: string };
export type RouteSlowSettings = RouteSlowSelection & {
  maxSlowPercent: string;
  contractConfirmed: boolean;
};
// K and E: requests and slow requests of the selected route among ordinary points.
// F and S: fast and slow observations in the SDK overflow, whose route is unknown.
// other: observations of other routes among ordinary points. They never enter a denominator.
export type RouteSlowCounts = { K: bigint; E: bigint; F: bigint; S: bigint; other: bigint };
export type RoutePoint = {
  attributes: Attributes;
  count: string;
  overflow: boolean;
  role: 'selected_route' | 'other_route' | 'overflow' | 'empty';
  route?: string;
  // Present for the points that take part in the calculation.
  fast?: string;
  slow?: string;
};
type Refusal = { status: Diagnostic['status']; diagnostic: Diagnostic };
export const ROUTE_CHECKS = [
  'one selected Resource, scope and metric stream; delta temporality; explicit-bucket Histogram',
  'metric http.server.request.duration with unit s',
  'one complete interval; all points of the interval validated before any route is selected',
  'SDK overflow shape: exactly one attribute, otel.metric.overflow = true',
  'a unique string http.route on every ordinary non-empty point',
  'complete bucket counts on every non-empty point, summing to its count',
  'the duration boundary is an exact explicit bound of the overflow and selected-route points',
];
export type RouteSlowPrepared = {
  status: 'APPLICABLE';
  route: string;
  durationSeconds: string;
  counts: RouteSlowCounts;
  points: RoutePoint[];
  checks: string[];
};
export type RouteSlowPreparation = RouteSlowPrepared | Refusal;
export type RouteSlowVerdict =
  | 'WITHIN_LIMIT'
  | 'EXCEEDS_LIMIT'
  | 'INDETERMINATE'
  | 'NO_ROUTE_OBSERVATIONS';
export type RouteSlowAnalysis =
  | Refusal
  | (RouteSlowCounts & {
      status: RouteSlowVerdict;
      route: string;
      durationSeconds: string;
      lower: Rational | null;
      upper: Rational | null;
      maximum: Rational;
      points: RoutePoint[];
    });

function refusal(error: unknown): Refusal {
  const d = diagnostic(error);
  return { status: d.status, diagnostic: d };
}

// The exact route string of an ordinary point. Anything but one nonempty string value is
// ambiguous: the point could belong to the selected route.
function readRoute(attrs: Attributes, path: string): string {
  if (!Object.hasOwn(attrs, HTTP_ROUTE_ATTRIBUTE))
    fail(
      'MISSING_ROUTE',
      `Every ordinary non-empty point needs the ${HTTP_ROUTE_ATTRIBUTE} measurement attribute. A point without it could belong to the selected route.`,
      path,
      'UNSUPPORTED_INPUT',
    );
  const raw = attrs[HTTP_ROUTE_ATTRIBUTE] as { stringValue?: unknown } | null;
  const value =
    raw && typeof raw === 'object' && Object.hasOwn(raw, 'stringValue') ? raw.stringValue : null;
  if (typeof value !== 'string' || value === '')
    fail(
      'INVALID_ROUTE',
      `${HTTP_ROUTE_ATTRIBUTE} must be a nonempty stringValue.`,
      path,
      'UNSUPPORTED_INPUT',
    );
  return value;
}

// A positive finite duration in seconds, written the way a bound is: `String(bound)`.
export function readDuration(text: string): number {
  if (!text) fail('DURATION_NOT_SELECTED', 'Select a duration boundary.');
  const n = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0)
    fail(
      'INVALID_DURATION_THRESHOLD',
      'The duration threshold must be a finite positive number of seconds.',
    );
  return n;
}

// Observations strictly above the boundary: every bucket after the one that ends at it.
function split(count: bigint, buckets: bigint[], boundIndex: number) {
  const slow = buckets.slice(boundIndex + 1).reduce((a, b) => a + b, 0n);
  return { fast: count - slow, slow };
}

export function prepareRouteSlowShare(
  stream: Stream,
  selection: RouteSlowSelection,
): RouteSlowPreparation {
  try {
    if (stream.diagnostics.length)
      return { status: stream.diagnostics[0].status, diagnostic: stream.diagnostics[0] };
    const { identity } = stream;
    if (identity.type !== 'histogram')
      fail(
        'UNSUPPORTED_TYPE',
        'The route slow-share mode requires an explicit-bucket Histogram.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    if (identity.name !== HTTP_METRIC)
      fail(
        'UNSUPPORTED_METRIC',
        `The route slow-share mode requires the ${HTTP_METRIC} metric.`,
        undefined,
        'UNSUPPORTED_INPUT',
      );
    if (identity.temporality !== 'DELTA')
      fail(
        'UNSUPPORTED_TEMPORALITY',
        'The route slow-share mode requires delta temporality and one complete interval.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    if (identity.unit !== HTTP_DURATION_UNIT)
      fail(
        'UNSUPPORTED_UNIT',
        `The route slow-share mode requires the unit ${HTTP_DURATION_UNIT} (seconds); this stream declares ${identity.unit ? `"${identity.unit}"` : 'no unit'}. Values are never converted.`,
        undefined,
        'UNSUPPORTED_INPUT',
      );
    const interval = stream.intervals.find((i) => i.id === selection.intervalId);
    if (!interval) fail('INTERVAL_NOT_SELECTED', 'Select one complete collection interval.');
    if (!selection.route)
      fail('ROUTE_NOT_SELECTED', `Enter the exact ${HTTP_ROUTE_ATTRIBUTE} value to analyze.`);
    const threshold = readDuration(selection.durationSeconds);
    const counts: RouteSlowCounts = { K: 0n, E: 0n, F: 0n, S: 0n, other: 0n };
    const seen = new Set<string>();
    const points: RoutePoint[] = interval.points.map((p, i) => {
      const path = `selectedInterval.points[${i}]`;
      const attrs = attributes(p.attributes, `${path}.attributes`);
      const key = canonical(attrs);
      if (seen.has(key))
        fail(
          'DUPLICATE_POINT',
          'Repeated measurement attribute sets within one interval are ambiguous or duplicate exports.',
          path,
        );
      seen.add(key);
      const { count, bounds, buckets } = readHistogramPoint(p, path);
      const overflow = overflowShape(attrs, path);
      const base = { attributes: attrs, count: count.toString(), overflow };
      if (count === 0n) return { ...base, role: overflow ? 'overflow' : 'empty' };
      const route = overflow ? undefined : readRoute(attrs, path);
      if (buckets.length === 0)
        fail(
          'MISSING_BUCKETS',
          'A non-empty point needs complete bucketCounts and explicitBounds. A missing distribution is never reconstructed from sum, min, max or exemplars.',
          path,
          'UNSUPPORTED_INPUT',
        );
      if (route !== undefined && route !== selection.route) {
        counts.other += count;
        return { ...base, role: 'other_route', route };
      }
      const boundIndex = bounds.indexOf(threshold);
      if (boundIndex < 0)
        fail(
          'THRESHOLD_NOT_A_BOUNDARY',
          `The duration ${selection.durationSeconds} s is not an explicit bucket boundary of this point (bounds: ${bounds.join(', ') || 'none'}). Values are never interpolated or rounded to a neighboring boundary.`,
          path,
          'UNSUPPORTED_INPUT',
        );
      const { fast, slow } = split(count, buckets, boundIndex);
      if (overflow) {
        counts.F += fast;
        counts.S += slow;
        return { ...base, role: 'overflow', fast: fast.toString(), slow: slow.toString() };
      }
      counts.K += count;
      counts.E += slow;
      return {
        ...base,
        role: 'selected_route',
        route,
        fast: fast.toString(),
        slow: slow.toString(),
      };
    });
    return {
      status: 'APPLICABLE',
      route: selection.route,
      durationSeconds: selection.durationSeconds,
      counts,
      points,
      checks: ROUTE_CHECKS,
    };
  } catch (error) {
    return refusal(error);
  }
}

// Reuses prepared counts when only the maximum share or the confirmation changes.
//
// With K > 0 and f, s the fast and slow overflow observations that belong to the route,
// the share is (E + s) / (K + f + s). It rises with s and falls with f, so
//   lower = E / (K + F)          (all fast overflow, no slow overflow)
//   upper = (E + S) / (K + S)    (all slow overflow, no fast overflow)
// The rest of the overflow can belong to other routes. With K = 0 the route may have had
// no requests at all, so no share is defined and nothing is claimed.
export function calculateRouteSlowShare(
  prepared: RouteSlowPreparation,
  settings: Pick<RouteSlowSettings, 'maxSlowPercent' | 'contractConfirmed'>,
): RouteSlowAnalysis {
  if (prepared.status !== 'APPLICABLE') return prepared;
  try {
    if (!settings.contractConfirmed)
      fail(
        'PROVENANCE_NOT_CONFIRMED',
        'Confirm the data provenance contract. A matching metric name cannot establish request semantics, route attribution, durations or delivery completeness.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    let maximum: Rational;
    try {
      maximum = thresholdPercent(settings.maxSlowPercent);
    } catch {
      fail(
        'INVALID_THRESHOLD',
        'Enter the maximum slow-request share as a decimal percentage from 0 to 100, using a dot and at most 100 digits.',
      );
    }
    const { K, E, F, S } = prepared.counts;
    const base = {
      ...prepared.counts,
      route: prepared.route,
      durationSeconds: prepared.durationSeconds,
      maximum,
      points: prepared.points,
    };
    if (K === 0n) return { ...base, status: 'NO_ROUTE_OBSERVATIONS', lower: null, upper: null };
    const lower = { numerator: E, denominator: K + F };
    const upper = { numerator: E + S, denominator: K + S };
    const status =
      compare(upper, maximum) <= 0n
        ? 'WITHIN_LIMIT'
        : compare(lower, maximum) > 0n
          ? 'EXCEEDS_LIMIT'
          : 'INDETERMINATE';
    return { ...base, status, lower, upper };
  } catch (error) {
    return refusal(error);
  }
}

export function analyzeRouteSlowShare(stream: Stream, settings: RouteSlowSettings) {
  return calculateRouteSlowShare(prepareRouteSlowShare(stream, settings), settings);
}

// Exact ordinary routes of the interval, for the selection list. Problems are reported by
// the preparation, not here.
export function routeCandidates(stream: Stream, intervalId: string): string[] {
  const routes = new Set<string>();
  for (const p of stream.intervals.find((i) => i.id === intervalId)?.points ?? [])
    try {
      const attrs = attributes(p.attributes, 'attributes');
      if (!overflowShape(attrs, 'attributes')) routes.add(readRoute(attrs, 'attributes'));
    } catch {
      /* the preparation reports the exact problem */
    }
  return [...routes].sort();
}

// Boundaries, in seconds, that exist in every non-empty point that would take part in the
// calculation for this route. With no such point, every boundary of the interval is offered.
export function durationCandidates(stream: Stream, intervalId: string, route: string): string[] {
  if (!route) return [];
  const participating: Set<number>[] = [];
  const every = new Set<number>();
  for (const p of stream.intervals.find((i) => i.id === intervalId)?.points ?? [])
    try {
      const attrs = attributes(p.attributes, 'attributes');
      const { count, bounds } = readHistogramPoint(p, 'point');
      for (const b of bounds) every.add(b);
      const overflow = overflowShape(attrs, 'attributes');
      if (count > 0n && (overflow || readRoute(attrs, 'attributes') === route))
        participating.push(new Set(bounds));
    } catch {
      /* the preparation reports the exact problem */
    }
  const [first, ...rest] = participating;
  const common = first ? [...first].filter((b) => rest.every((set) => set.has(b))) : [...every];
  return common
    .filter((b) => b > 0)
    .sort((a, b) => a - b)
    .map(String);
}

// Display only. The exact selection is always the seconds value.
export function millisecondsLabel(seconds: string): string {
  const ms = Number(seconds) * 1000;
  return `${Number(ms.toPrecision(12))} ms`;
}
