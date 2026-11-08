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
                  {valid.F + valid.S > 0n
                    ? 'Possible true share of slow requests · nonzero uncertainty'
                    : 'Exact share of slow requests · no overflow observations'}
                </p>
                <Range
                  lower={bounded.lower}
                  upper={bounded.upper}
                  threshold={valid.maximum}
                  uncertain={valid.F + valid.S > 0n}
                  subject="slow-request share"
                />
                <div className="explanation">
                  <strong>
                    {valid.status === 'INDETERMINATE'
                      ? 'Both outcomes remain possible.'
                      : valid.status === 'WITHIN_LIMIT'
                        ? 'Every possible assignment of the overflow meets your limit.'
                        : 'Every possible assignment of the overflow exceeds your limit.'}
                  </strong>
                  <p>
                    {valid.status === 'INDETERMINATE'
                      ? 'Some assignments of the overflow observations to this route meet the limit, and others exceed it. These data cannot settle the question.'
                      : valid.status === 'WITHIN_LIMIT'
                        ? `Even if every slow overflow observation belonged to ${route} and no fast one did, the share of its requests longer than ${limit} would stay at or below the maximum.`
                        : `The known slow requests of ${route} alone exceed the maximum, even if every fast overflow observation belonged to it and no slow one did.`}
                  </p>
                  {valid.F + valid.S > 0n && (
                    <p data-testid="unknown-attribution">
                      The SDK replaced the attributes of {(valid.F + valid.S).toString()} overflow
                      observations, including <code>{HTTP_ROUTE_ATTRIBUTE}</code>. Their route is
                      unknown, so each of them may or may not belong to {route}. Their durations are
                      still sorted into buckets: {valid.F.toString()} were not longer than {limit}{' '}
                      and {valid.S.toString()} were longer.
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
                  reported. The SDK overflow holds {(valid.F + valid.S).toString()} observations
                  whose route is unknown. Some of them may belong to this route, but nothing in the
                  export shows that any does, and the route may have had no requests.
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
        <div className="counts">
          {(
            [
              ['K', 'Known route requests'],
              ['E', 'Known slow'],
              ['F', 'Overflow, not slower'],
              ['S', 'Overflow, slower'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <span>
                {label} <code>{key}</code>
              </span>
              <strong>{valid ? valid[key].toString() : '—'}</strong>
            </div>
          ))}
        </div>
        <p className="fine">
          Known fast requests of the route = K − E{valid ? ` = ${valid.K - valid.E}` : ''}.{' '}
          {valid
            ? `${valid.other} known observations of other routes are excluded from every denominator.`
            : 'Observations of other routes are excluded from every denominator.'}{' '}
          The route of overflow observations is unknown; they are not added to K.
        </p>
      </section>
      <section className="panel method-panel">
        <h2>Bounds you can check</h2>
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
          <p>
            One complete delta interval of an explicit-bucket <code>{HTTP_METRIC}</code> Histogram
            in seconds. Every ordinary non-empty point has one string{' '}
            <code>{HTTP_ROUTE_ATTRIBUTE}</code> and complete bucket counts, and the chosen duration
            is an exact bucket boundary of the overflow and selected-route points. Cumulative and
            exponential histograms, status codes, quantiles and other attributes are not analyzed.
          </p>
          <p>
            SDK overflow must have exactly one measurement attribute:{' '}
            <code>otel.metric.overflow = true</code>. Data lost before the export cannot be
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
          assumptions, source SHA-256 and per-point evidence.
        </p>
      </section>
    </>
  );
}
