import {
  type CumulativeAnalysis,
  calculateWindow,
  type Pairing,
  pairWindow,
  type WindowBoundaries,
  type WindowProfile,
} from './cumulative';
import { readHistogramPoint } from './histogram';
import { classifyHttpPoint } from './http';
import { attributes } from './parse';
import { fail, HTTP_METRIC, type Stream } from './types';

export type HttpCumulativeSelection = WindowBoundaries;
export type HttpCumulativeSettings = HttpCumulativeSelection & {
  threshold: string;
  contractConfirmed: boolean;
};
// Per-series bucket evidence. It is never used as a latency estimate; it only
// shows whether two points can belong to one continuous aggregation.
type Layout = { bounds: number[]; buckets: bigint[] };

// A changed bucket layout or a shrinking bucket under an unchanged start time cannot
// come from one continuous cumulative aggregation: an SDK that reconfigures or
// resets an aggregator reports a new start time. The count would still look valid, so
// the pair is refused. Description, sum, min, max and exemplars are not used and
// cannot change the count increment; they do not affect applicability.
function sameHistory(before: Layout, after: Layout, path: string) {
  if (
    before.bounds.length !== after.bounds.length ||
    before.bounds.some((bound, i) => bound !== after.bounds[i]) ||
    before.buckets.length !== after.buckets.length
  )
    fail(
      'CHANGED_BUCKET_LAYOUT',
      'Matched series report different explicit bucket boundaries; the aggregation was reconfigured without a recorded start time change.',
      path,
      'UNSUPPORTED_INPUT',
    );
  for (const [i, count] of before.buckets.entries())
    if (after.buckets[i] < count)
      fail(
        'DECREASING_BUCKET',
        `Bucket ${i} decreased from ${count} to ${after.buckets[i]} while the total did not; the series was reset or rewritten.`,
        path,
        'UNSUPPORTED_INPUT',
      );
}

const profile: WindowProfile<Layout> = {
  checks: [
    'identical Resource, scope, schema URLs and metric definition (type, unit, cumulative temporality)',
    'valid explicit-bucket histogram points in both exports',
    'one collection timestamp per export',
    'strictly ordered collection timestamps',
    'equal unique measurement identity sets, no zero fill',
    'known unchanged per-series start times before window',
    'nondecreasing integer counts per point',
    'unchanged bucket boundaries and nondecreasing bucket counts per series',
    'integer http.response.status_code from 100 to 599 on every ordinary point',
    'SDK overflow shape',
  ],
  stream(identity, side) {
    if (identity.type !== 'histogram')
      fail(
        'UNSUPPORTED_TYPE',
        'Cumulative HTTP 5xx mode requires two explicit-bucket Histograms.',
        side,
        'UNSUPPORTED_INPUT',
      );
    if (identity.name !== HTTP_METRIC)
      fail(
        'UNSUPPORTED_METRIC',
        `Cumulative HTTP 5xx mode requires the ${HTTP_METRIC} metric.`,
        side,
        'UNSUPPORTED_INPUT',
      );
    if (identity.temporality !== 'CUMULATIVE')
      fail(
        'UNSUPPORTED_TEMPORALITY',
        'Cumulative HTTP 5xx mode requires cumulative temporality on both sides; use the delta HTTP 5xx mode for one interval.',
        side,
        'UNSUPPORTED_INPUT',
      );
  },
  selection() {},
  read(raw, path) {
    const { count, bounds, buckets } = readHistogramPoint(raw, path);
    const attrs = attributes(raw.attributes, `${path}.attributes`);
    return { point: classifyHttpPoint(attrs, count, path), evidence: { bounds, buckets } };
  },
  isError: (point) => point.responseClass === 'server_error',
  continuity: sameHistory,
};

export function pairHttpCumulative(
  before: Stream,
  after: Stream,
  selection: HttpCumulativeSelection,
): Pairing {
  return pairWindow(before, after, selection, profile);
}

export function calculateHttpCumulative(
  pair: Pairing,
  settings: Pick<HttpCumulativeSettings, 'threshold' | 'contractConfirmed'>,
): CumulativeAnalysis {
  return calculateWindow(
    pair,
    settings,
    'Confirm both complete cumulative HTTP exports, one continuous source history, correct status codes, and that downstream processing changed neither counts nor attribution. Structure cannot prove these assumptions.',
  );
}

export function analyzeHttpCumulative(
  before: Stream,
  after: Stream,
  settings: HttpCumulativeSettings,
): CumulativeAnalysis {
  return calculateHttpCumulative(pairHttpCumulative(before, after, settings), settings);
}
