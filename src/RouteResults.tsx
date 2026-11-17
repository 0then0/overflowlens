import { formatPercent } from './core/calculate';
import {
  millisecondsLabel,
  type RouteSlowAnalysis,
  type RouteSlowPreparation,
  type RouteSlowVerdict,
} from './core/routeSlow';
import { HTTP_METRIC, HTTP_ROUTE_ATTRIBUTE, type Stream } from './core/types';
import { fraction, Range } from './Range';

const verdictLabels: Record<RouteSlowVerdict | 'UNSUPPORTED_INPUT' | 'INVALID_INPUT', string> = {
  WITHIN_LIMIT: 'Within limit for the imported interval',
  EXCEEDS_LIMIT: 'Exceeds limit for the imported interval',
  INDETERMINATE: 'Cannot determine from these data',
  NO_ROUTE_OBSERVATIONS: 'No confirmed observations of this route',
  UNSUPPORTED_INPUT: 'Unsupported input',
  INVALID_INPUT: 'Invalid input',
};
const threshold = (seconds: string) => `${seconds} s (${millisecondsLabel(seconds)})`;

export function RouteResults({
  stream,
  intervalId,
  route,
  durationSeconds,
  prepared,
  result,
  canExport,
  onExport,
}: {
  stream: Stream | undefined;
  intervalId: string;
  route: string;
  durationSeconds: string;
  prepared: RouteSlowPreparation | null;
  result: RouteSlowAnalysis | null;
  canExport: boolean;
  onExport: () => void;
}) {
  const valid = result && 'K' in result ? result : null;
  const bounded = valid?.lower && valid.upper ? { lower: valid.lower, upper: valid.upper } : null;
  const limit = durationSeconds ? threshold(durationSeconds) : 'the threshold';
  const exponential = stream?.identity.type === 'exponentialHistogram';
  // Observations whose side of the threshold, or whose route, is unknown.
  const fromThreshold = valid ? valid.B + valid.X : 0n;
  const fromRoute = valid ? valid.F + valid.S + valid.X : 0n;
  const uncertain = fromThreshold + fromRoute > 0n;
  return (
    <>
      <section
        className={`panel result-panel ${result?.status.toLowerCase() ?? ''}`}
        aria-live="polite"
      >
        <div className="result-heading">
          <span className="eyebrow">WHAT THE DATA SUPPORTS</span>
          <span className="mini-label">ROUTE SLOW-REQUEST SHARE</span>
        </div>
        {!result ? (
          <div className="empty">
            <div className="empty-symbol">[ ? ]</div>
            <h2>Your histogram keeps durations, not routes.</h2>
            <p>
              Import an export or load the example, select the interval, one{' '}
              <code>{HTTP_ROUTE_ATTRIBUTE}</code> and a duration boundary, then confirm the
              conditions to see what the data support.
            </p>
          </div>
        ) : valid ? (
          <>
            <div className="verdict">
              <span className="verdict-symbol">
                {valid.status === 'WITHIN_LIMIT'
                  ? '✓'
                  : valid.status === 'EXCEEDS_LIMIT'
                    ? '!'
                    : '?'}
              </span>
              <h2>{verdictLabels[valid.status]}</h2>
            </div>
            {bounded ? (
              <>
                <div className="range-number" data-testid="range">
                  {formatPercent(bounded.lower)} <span>…</span> {formatPercent(bounded.upper)}
                </div>
                <p className="range-caption">
                  {uncertain
                    ? 'Possible true share of slow requests · nonzero uncertainty'
                    : exponential
                      ? 'Exact share of slow requests · no overflow or threshold-crossing observations'
                      : 'Exact share of slow requests · no overflow observations'}
                </p>
                <Range
                  lower={bounded.lower}
                  upper={bounded.upper}
                  threshold={valid.maximum}
                  uncertain={uncertain}
                  subject="slow-request share"
                />
                <div className="explanation">
                  <strong>
                    {valid.status === 'INDETERMINATE'
                      ? 'Both outcomes remain possible.'
                      : valid.status === 'WITHIN_LIMIT'
                        ? `Every possible assignment of the ${exponential ? 'uncertain observations and the ' : ''}overflow meets your limit.`
                        : `Every possible assignment of the ${exponential ? 'uncertain observations and the ' : ''}overflow exceeds your limit.`}
                  </strong>
                  <p>
                    {exponential
                      ? valid.status === 'INDETERMINATE'
                        ? 'Some ways of resolving the threshold-crossing buckets and assigning the overflow to this route meet the limit, and others exceed it. These data cannot settle the question.'
                        : valid.status === 'WITHIN_LIMIT'
                          ? `Even if every uncertain observation were longer than ${limit}, every possibly slow overflow observation belonged to ${route} and no fast one did, the share would stay at or below the maximum.`
                          : `The certainly slow requests of ${route} alone exceed the maximum, even if every uncertain observation were not longer than ${limit} and every possibly fast overflow observation belonged to it.`
                      : valid.status === 'INDETERMINATE'
                        ? 'Some assignments of the overflow observations to this route meet the limit, and others exceed it. These data cannot settle the question.'
                        : valid.status === 'WITHIN_LIMIT'
                          ? `Even if every slow overflow observation belonged to ${route} and no fast one did, the share of its requests longer than ${limit} would stay at or below the maximum.`
                          : `The known slow requests of ${route} alone exceed the maximum, even if every fast overflow observation belonged to it and no slow one did.`}
                  </p>
                  {exponential && fromThreshold > 0n && (
                    <p data-testid="threshold-crossing">
                      {fromThreshold.toString()} observations ({valid.B.toString()} of {route},{' '}
                      {valid.X.toString()} in the overflow) lie in buckets whose range contains{' '}
                      {limit}. They may be on either side of the threshold, and their exact
                      durations are not recorded.
                    </p>
                  )}
                  {!exponential && valid.F + valid.S > 0n && (
                    <p data-testid="unknown-attribution">
                      The SDK replaced the attributes of {(valid.F + valid.S).toString()} overflow
                      observations, including <code>{HTTP_ROUTE_ATTRIBUTE}</code>. Their route is
                      unknown, so each of them may or may not belong to {route}. Their durations are
                      still sorted into buckets: {valid.F.toString()} were not longer than {limit}{' '}
                      and {valid.S.toString()} were longer.
                    </p>
                  )}
                  {exponential && fromRoute > 0n && (
                    <p data-testid="unknown-attribution">
                      The SDK replaced the attributes of {fromRoute.toString()} overflow
                      observations, including <code>{HTTP_ROUTE_ATTRIBUTE}</code>. Their route is
                      unknown, so each of them may or may not belong to {route}. By bucket,{' '}
                      {valid.F.toString()} were not longer than {limit}, {valid.S.toString()} were
                      longer and {valid.X.toString()} may be either.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="explanation" data-testid="no-route-observations">
                <strong>
                  The data contain no confirmed request of <code>{route}</code>.
                </strong>
                <p>
                  No ordinary datapoint carries this route, so no share, bound or verdict is
                  reported. The SDK overflow holds {fromRoute.toString()} observations whose route
                  is unknown. Some of them may belong to this route, but nothing in the export shows
                  that any does, and the route may have had no requests.
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="diagnostic">
            <h2>{verdictLabels[result.status]}</h2>
            {'diagnostic' in result && (
              <>
                <p>{result.diagnostic.message}</p>
                <code>{result.diagnostic.code}</code>
                {result.diagnostic.path && <p className="fine">{result.diagnostic.path}</p>}
              </>
            )}
          </div>
        )}
      </section>
      <section className="panel counts-panel">
        <h2>Every observation accounted for</h2>
        {stream && (
          <dl className="selection" data-testid="selection">
            <dt>Stream</dt>
            <dd>
              {stream.identity.name} · {stream.identity.scope.name || '(unnamed scope)'} ·{' '}
              {stream.identity.temporality} · unit {stream.identity.unit || '(none)'}
            </dd>
            <dt>Interval</dt>
            <dd>{intervalId ? <code>{intervalId.replace(':', ' → ')} ns</code> : '—'}</dd>
            <dt>Route</dt>
            <dd>{route ? <code>{route}</code> : '—'}</dd>
            <dt>Slow means</dt>
            <dd data-testid="slow-definition">
              {durationSeconds
                ? `longer than ${threshold(durationSeconds)}; exactly ${durationSeconds} s is not slow`
                : '—'}
            </dd>
          </dl>
        )}
        <div className={exponential ? 'counts six' : 'counts'}>
          {(exponential
            ? ([
                ['K', 'K', 'Known route requests'],
                ['E', 'L', 'Known, certainly slower'],
                ['B', 'B', 'Known, crossing threshold'],
                ['F', 'F', 'Overflow, not slower'],
                ['S', 'S', 'Overflow, slower'],
                ['X', 'X', 'Overflow, crossing threshold'],
              ] as const)
            : ([
                ['K', 'K', 'Known route requests'],
                ['E', 'E', 'Known slow'],
                ['F', 'F', 'Overflow, not slower'],
                ['S', 'S', 'Overflow, slower'],
              ] as const)
          ).map(([key, symbol, label]) => (
            <div key={key}>
              <span>
                {label} <code>{symbol}</code>
              </span>
              <strong>{valid ? valid[key].toString() : '—'}</strong>
            </div>
          ))}
        </div>
        {exponential && (
          <dl className="selection" data-testid="uncertainty-sources">
            <dt>Threshold crossing</dt>
            <dd>{valid ? `${fromThreshold} uncertain (B + X)` : '—'}</dd>
            <dt>Route lost</dt>
            <dd>{valid ? `${fromRoute} uncertain (F + S + X)` : '—'}</dd>
          </dl>
        )}
        <p className="fine">
          {exponential
            ? `Certainly fast known requests of the route = K − L − B${valid ? ` = ${valid.K - valid.E - valid.B}` : ''}. Overflow observations in crossing buckets (X) are uncertain for both reasons and are counted in both lines. `
            : `Known fast requests of the route = K − E${valid ? ` = ${valid.K - valid.E}` : ''}. `}
          {valid
            ? `${valid.other} known observations of other routes are excluded from every denominator.`
            : 'Observations of other routes are excluded from every denominator.'}{' '}
          The route of overflow observations is unknown; they are not added to K.
        </p>
      </section>
      <section className="panel method-panel">
        <h2>Bounds you can check</h2>
        {exponential ? (
          <div className="formula-row">
            <div>
              <span>LOWER BOUND</span>
              <code>L / (K + F_max)</code>
              {bounded && <p>{fraction(bounded.lower)}</p>}
              <p>
                L = E, F_max = F + X. Every uncertain observation is fast; every possibly fast
                overflow observation belongs to the route, no slow one does.
              </p>
            </div>
            <div>
              <span>UPPER BOUND</span>
              <code>(U + S_max) / (K + S_max)</code>
              {bounded && <p>{fraction(bounded.upper)}</p>}
              <p>
                U = E + B, S_max = S + X. Every uncertain observation is slow; every possibly slow
                overflow observation belongs to the route, no fast one does.
              </p>
            </div>
          </div>
        ) : (
          <div className="formula-row">
            <div>
              <span>LOWER BOUND</span>
              <code>E / (K + F)</code>
              {bounded && <p>{fraction(bounded.lower)}</p>}
              <p>Every fast overflow observation belongs to the route; no slow one does.</p>
            </div>
            <div>
              <span>UPPER BOUND</span>
              <code>(E + S) / (K + S)</code>
              {bounded && <p>{fraction(bounded.upper)}</p>}
              <p>Every slow overflow observation belongs to the route; no fast one does.</p>
            </div>
          </div>
        )}
        <p>
          These extremes are attainable under the stated assumptions, with the remaining overflow
          observations belonging to other routes. They describe what is possible, not how likely it
          is. No route attribution is recovered, and durations are never interpolated within a
          bucket. Without any known request of the route (K = 0) nothing is claimed.
        </p>
        {valid && (
          <p className="fine">
            Exact maximum share fraction: <code>{fraction(valid.maximum)}</code>. Display rounding
            never affects the verdict.
          </p>
        )}
        <details>
          <summary>When this model applies</summary>
          {exponential ? (
            <p>
              One complete delta interval of a <code>{HTTP_METRIC}</code> ExponentialHistogram in
              seconds, scale −10 to 20. Each point keeps its own scale and offset; a bucket{' '}
              <code>(base^i, base^(i+1)]</code> is fast when its upper bound is at most the
              threshold, slow when its lower bound is at least the threshold, and uncertain
              otherwise or when floating-point error could change the comparison. The zero bucket
              covers <code>[−zeroThreshold, zeroThreshold]</code>. Negative buckets must be empty.
              Sum, min, max and exemplars never narrow the range. Cumulative histograms, quantiles
              and merged intervals are not analyzed.
            </p>
          ) : (
            <p>
              One complete delta interval of an explicit-bucket <code>{HTTP_METRIC}</code> Histogram
              in seconds. Every ordinary non-empty point has one string{' '}
              <code>{HTTP_ROUTE_ATTRIBUTE}</code> and complete bucket counts, and the chosen
              duration is an exact bucket boundary of the overflow and selected-route points.
              Cumulative histograms, status codes, quantiles and other attributes are not analyzed;
              an ExponentialHistogram stream takes a typed threshold instead.
            </p>
          )}
          <p>
            SDK overflow must have exactly one measurement attribute:{' '}
            <code>otel.metric.overflow = true</code>. That shape alone does not establish where the
            point came from or that the export is complete. Data lost before the export cannot be
            detected.
          </p>
          {prepared?.status === 'APPLICABLE' && (
            <ul className="checks" data-testid="route-checks">
              {prepared.checks.map((check) => (
                <li key={check}>✓ {check}</li>
              ))}
            </ul>
          )}
        </details>
        <button type="button" className="export-button" disabled={!canExport} onClick={onExport}>
          Export explanatory JSON <span>↓</span>
        </button>
        <p className="fine">
          Includes the route, duration threshold, exact counts and fractions, identity, interval,
          assumptions, source SHA-256 and per-point evidence
          {exponential
            ? ', with the scale, buckets and classification of every relevant point'
            : ''}
          .
        </p>
      </section>
    </>
  );
}
