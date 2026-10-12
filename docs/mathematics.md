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

## Why outcomes cannot be recovered

The synthetic [demo export](../public/examples/demo.json) has ordinary counts `success=true:900`, `success=false:1`, and overflow 99. Hold the Resource, scope, unit, timestamps and emitted attributes fixed.

One compatible history has 900 retained successes, 1 retained error and 99 unretained successes. Another has the same retained observations and 99 unretained errors. Both project onto the same aggregate JSON, with true rates `1/1000` and `100/1000` respectively.

This is a mathematical construction demonstrating information loss. The [Go SDK validation](validation.md) separately uses an independently recorded workload with 34 errors among 1,000 requests and verifies containment in the exported bounds.

## Display and tests

Displayed percentages are truncated at six decimal places, with an approximation marker when needed. Smaller positive fractions use `<0.000001%`. Chart positions are approximate, and narrow uncertainty ranges use a minimum visible mark. Exact fractions determine the verdict even when rounded endpoints look equal.

The test suite exhaustively checks every compatible overflow-error allocation for `K=0..7`, `E=0..K`, `O=0..7`, and thresholds `0/10..10/10`. It also checks large integers, threshold equality, empty totals, cumulative baseline exclusion, individual decreases, and reuse of prepared counts across threshold and provenance changes.
