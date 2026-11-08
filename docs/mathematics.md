# Mathematical model

OverflowLens bounds the error rate of one complete delta interval or one supported cumulative window. The [input contract](input-contract.md) defines the counter, outcome, overflow and provenance assumptions.

## Counts and compatible outcomes

Let K be the ordinary request count, E the ordinary error count, O the SDK overflow count, and T = K + O. All are nonnegative integers, with `0 ≤ E ≤ K`. Let x be the unknown number of errors in overflow. Its admissible values are the integers `0 ≤ x ≤ O`, and each compatible error rate is `(E + x) / T`.

For `T > 0`, the expression increases with x:

```text
lower = E / T
upper = (E + O) / T
```

The lower endpoint is attained when all overflow requests succeed; the upper when all fail. Compatible rates for a fixed integer total lie on a discrete grid with step `1/T`, not at every real number between the endpoints. If O is zero, both endpoints coincide. If T is zero, the fraction is undefined and the result is `NO_DATA`.

## Threshold decisions

For a maximum allowed error rate p, meeting the limit means `rate ≤ p`:

- `upper ≤ p`: every compatible allocation meets the limit, giving `WITHIN_LIMIT`.
- `lower > p`: every compatible allocation exceeds it, giving `EXCEEDS_LIMIT`.
- Otherwise, allocations exist on both sides of the limit, giving `INDETERMINATE`.

With positive denominators, the sign of `a/b − c/d` equals the sign of `a*d − c*b`. OverflowLens uses exact BigInt cross-products. A decimal percentage `w.f` becomes the fraction `wf / (100 × 10^digits(f))`. Floating-point display values do not participate in decisions.

## Cumulative subtraction

Let bᵢ and aᵢ be the Before and After counts of each matched measurement identity. Require the same complete identity set, ordered common collection timestamps, a known unchanged start for each corresponding series, nondecreasing counts and stable SDK attribution. Then `dᵢ = aᵢ − bᵢ` counts observations in `(before, after]` for that aggregator.

Different series may have different starts because each cumulative history cancels individually. A missing counterpart, unknown start, reset or decrease breaks this argument and refuses the pair. A positive total cannot conceal a negative individual increment.

For the window, K is the sum of ordinary increments, E the sum of ordinary error increments, O the overflow increment, and T = K + O. O is zero when overflow is absent at both boundaries. SDK count conservation makes these increments an exhaustive partition of window requests under the confirmed provenance assumptions. Baseline observations are excluded.

Apply the same fractions, threshold decisions and NO_DATA rule to these increments. Subtracting percentages or snapshot bounds does not calculate the window population.

## Attainable cumulative endpoints

The [synchronous cumulative SDK contract](https://opentelemetry.io/docs/specs/otel/metrics/sdk/#cardinality-limits) retains ordinary attribute sets established before overflow. Within the supported model, any integer number of window overflow errors from zero to O is compatible with the saved aggregates: unretained measurement attributes can carry successful or failed requests without changing their single-marker aggregate.

Both endpoint allocations are therefore attainable while keeping the baseline fixed. This requires the confirmed continuous source history and unchanged aggregation/attribution, not merely matching metadata. Exemplars cannot enumerate all overflow outcomes.

## HTTP 5xx histogram

For a delta `http.server.request.duration` histogram the same model applies with different definitions. K is the sum of `count` over ordinary points, each classified by its integer HTTP status, E is the sum over ordinary points with status 500–599, O is the `count` of the SDK overflow point, and T = K + O. The unknown number of overflow requests with a 5xx status is an integer from 0 to O, so the bounds are `E / T` and `(E + O) / T`, and the threshold decisions, `NO_DATA` rule and BigInt arithmetic are unchanged. Histogram `count` conserves observations: the SDK places every measurement in exactly one aggregator, ordinary or overflow. Bucket counts, sums and latency do not enter the calculation, and overflow cannot be split by status or route.

### Cumulative HTTP 5xx window

For two cumulative snapshots of the same explicit-bucket histogram, K, E and O are sums of per-series `count` increments `count(after) − count(before)`, with the same classification, bounds and threshold rules. Baseline observations cancel only when every series has one continuous history: the same start time, no decrease and the same series in both exports. Otherwise the difference is not the window and the pair is refused. Snapshot bounds are never subtracted. Unretained requests keep their SDK semantics: window requests that arrive after the cardinality limit is reached land in the overflow series, so the overflow increment is the window's own `O`.

## Route slow share

For one exact `http.route` of a delta `http.server.request.duration` histogram, choose a duration boundary `d` that is an explicit bucket bound. A request is slow when its duration is strictly greater than `d`; an observation equal to `d` is fast, because bucket upper bounds are inclusive. Let `K` be the requests of the route among ordinary points, `E` the slow ones among them, `F` the fast and `S` the slow observations in SDK overflow. Ordinary observations of other routes are not in the denominator.

SDK overflow loses `http.route`, but its histogram keeps the bucket distribution, so `F` and `S` are known while the route of each overflow observation is not. Let `f` fast and `s` slow overflow observations belong to the route, with integers `0 ≤ f ≤ F` and `0 ≤ s ≤ S`; the rest belong to other routes. The route's slow share is

```text
(E + s) / (K + f + s)
```

For `K > 0` the denominator is positive. With `E ≤ K` the expression does not decrease in `s` and does not increase in `f`, so

```text
lower = E / (K + F)        f = F, s = 0
upper = (E + S) / (K + S)  f = 0, s = S
```

Both are attained by those assignments; the thresholds are decided as above (`upper ≤ p` within, `lower > p` exceeds). Attributing all overflow to the route, or using `K + F + S` as a fixed denominator, would be wrong: it forces every other route's overflow observations into this route. With `K = 0` the data admit `f = s = 0`, a route without requests, so the share is undefined and nothing is reported, even if the overflow is not empty. Example: `K=900, E=9, F=90, S=10` gives `9/990 … 19/910`, about 0.91% … 2.09%.

Durations are never interpolated within a bucket, and the bounds are not a confidence interval. The test suite enumerates all `f` and `s` for `K=1..7`, `E=0..K`, `F=0..6`, `S=0..6` and checks the minimum and maximum against the formulas.

## Why outcomes cannot be recovered

The synthetic [demo export](../public/examples/demo.json) has ordinary counts `success=true:900`, `success=false:1`, and overflow 99. Hold the Resource, scope, unit, timestamps and emitted attributes fixed.

One compatible history has 900 retained successes, 1 retained error and 99 unretained successes. Another has the same retained observations and 99 unretained errors. Both project onto the same aggregate JSON, with true rates `1/1000` and `100/1000` respectively.

This is a mathematical construction demonstrating information loss. The [Go SDK validation](validation.md) separately uses an independently recorded workload with 34 errors among 1,000 requests and verifies containment in the exported bounds.

## Display and tests

Displayed percentages are truncated at six decimal places, with an approximation marker when needed. Smaller positive fractions use `<0.000001%`. Chart positions are approximate, and narrow uncertainty ranges use a minimum visible mark. Exact fractions determine the verdict even when rounded endpoints look equal.

The test suite exhaustively checks every compatible overflow-error allocation for `K=0..7`, `E=0..K`, `O=0..7`, and thresholds `0/10..10/10`. It also checks large integers, threshold equality, empty totals, cumulative baseline exclusion, individual decreases, and reuse of prepared counts across threshold and provenance changes.
