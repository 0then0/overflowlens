import { overflowShape } from './analyze';
import { calculate, thresholdPercent } from './calculate';
import { readHistogramPoint } from './histogram';
import { attributes, canonical } from './parse';
import {
  type Analysis,
  diagnostic,
  fail,
  HTTP_METRIC,
  HTTP_STATUS_ATTRIBUTE,
  type Stream,
} from './types';

export type HttpSettings = {
  intervalId: string;
  threshold: string;
  contractConfirmed: boolean;
};
type Points = Extract<Analysis, { K: bigint }>['points'];

// Classifies one ordinary point by its integer HTTP status code. Any status that
// cannot be established unambiguously refuses the whole calculation.
export function readStatusCode(attrs: Record<string, unknown>, path: string): number {
  if (!Object.hasOwn(attrs, HTTP_STATUS_ATTRIBUTE))
    fail(
      'MISSING_STATUS_CODE',
      `Every ordinary point needs the ${HTTP_STATUS_ATTRIBUTE} measurement attribute. Requests that ended without a response cannot be classified.`,
      path,
    );
  const raw = attrs[HTTP_STATUS_ATTRIBUTE];
  const text =
    raw && typeof raw === 'object' && Object.hasOwn(raw, 'intValue')
      ? String((raw as { intValue: unknown }).intValue)
      : '';
  const status = /^\d+$/.test(text) ? BigInt(text) : -1n;
  if (status < 100n || status > 599n)
    fail(
      'INVALID_STATUS_CODE',
      `${HTTP_STATUS_ATTRIBUTE} must be an intValue from 100 to 599.`,
      path,
    );
  if (Object.hasOwn(attrs, 'error.type')) {
    const errorType = attrs['error.type'];
    if (!errorType || typeof errorType !== 'object' || !Object.hasOwn(errorType, 'stringValue'))
      fail('INVALID_ERROR_TYPE', 'error.type must be a stringValue when present.', path);
    const value = (errorType as { stringValue: string }).stringValue;
    if (/^\d{3}$/.test(value) && value !== text)
      fail(
        'CONTRADICTORY_STATUS',
        `error.type is ${value}, but ${HTTP_STATUS_ATTRIBUTE} is ${text}.`,
        path,
      );
  }
  return Number(status);
}

export function analyzeHttp(stream: Stream, settings: HttpSettings): Analysis {
  try {
    if (stream.diagnostics.length)
      return { status: stream.diagnostics[0].status, diagnostic: stream.diagnostics[0] };
    if (stream.identity.type !== 'histogram')
      fail(
        'UNSUPPORTED_TYPE',
        'HTTP 5xx mode requires an explicit-bucket Histogram.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    if (stream.identity.name !== HTTP_METRIC)
      fail(
        'UNSUPPORTED_METRIC',
        `HTTP 5xx mode requires the ${HTTP_METRIC} metric.`,
        undefined,
        'UNSUPPORTED_INPUT',
      );
    if (stream.identity.temporality !== 'DELTA')
      fail(
        'UNSUPPORTED_TEMPORALITY',
        'HTTP 5xx mode requires delta temporality; cumulative histograms are not supported.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    if (!settings.contractConfirmed)
      fail(
        'PROVENANCE_NOT_CONFIRMED',
        'Confirm the data provenance contract. A matching metric name cannot establish request semantics, status attribution or delivery completeness.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    const interval = stream.intervals.find((i) => i.id === settings.intervalId);
    if (!interval) fail('INTERVAL_NOT_SELECTED', 'Select one complete collection interval.');
    const threshold = thresholdPercent(settings.threshold);
    let K = 0n,
      E = 0n,
      O = 0n;
    const seen = new Set<string>();
    const points: Points = interval.points.map((p, i) => {
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
      const { count } = readHistogramPoint(p, path);
      if (overflowShape(attrs, path)) {
        O += count;
        return { attributes: attrs, count: count.toString(), overflow: true };
      }
      const status = readStatusCode(attrs, path);
      K += count;
      if (status >= 500) E += count;
      return {
        attributes: attrs,
        count: count.toString(),
        overflow: false,
        statusCode: String(status),
        responseClass: status >= 500 ? 'server_error' : 'other',
      };
    });
    return { ...calculate(K, E, O, threshold), points };
  } catch (error) {
    const d = diagnostic(error);
    return { status: d.status, diagnostic: d };
  }
}
