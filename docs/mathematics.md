# Mathematical model

This model explains the bounds and conclusions displayed by OverflowLens. Its assumptions are defined in the [input contract](input-contract.md).

Assume a complete interval of a synchronous SDK request counter, a binary outcome on each request, no value-changing or attribute-changing downstream transformations, and the SDK overflow shape described in the input contract.

Let `K` be the sum of ordinary counts, `E` the ordinary error count, `O` the overflow count and `T = K + O`. All are nonnegative integers and `0 ≤ E ≤ K`. Let `x` denote the unknown number of errors inside overflow. The admissible values are precisely the integers `0 ≤ x ≤ O`, and each compatible error rate is `(E + x) / T`.

For `T > 0`, this expression increases with `x`, so the exact extrema are `E / T` and `(E + O) / T`. The lower endpoint is achieved by allocating every overflow request to success, the upper by allocating every overflow request to error. “Range” means the enclosing interval; attainable rates for a fixed integer total lie on a discrete grid of steps `1/T`, not at every real number between the endpoints. If `O=0`, both endpoints coincide. If `T=0`, the fraction is undefined and the result is `NO_DATA`.

For a maximum allowed error rate `p`, meeting the limit means `rate ≤ p`. Thus:

- `upper ≤ p`: every compatible allocation meets the limit (`WITHIN_LIMIT`).
- `lower > p`: every compatible allocation exceeds it (`EXCEEDS_LIMIT`).
- otherwise: the lower endpoint meets the limit and the upper exceeds it (`INDETERMINATE`).

For positive denominators, the sign of `a/b − c/d` is the sign of `a*d − c*b`. The implementation uses exact `BigInt` cross-products. A decimal percentage `w.f` becomes integer `wf / (100 × 10^digits(f))`. No floating-point conversion participates in a decision.

## Why outcomes cannot be recovered

The synthetic [demo export](../public/examples/demo.json) contains ordinary counts `success=true:900`, `success=false:1`, and overflow count `99`. Hold the Resource, scope, unit, timestamps and all emitted attributes fixed.

History A has 900 retained successes, 1 retained error and 99 unretained successes. History B has the same retained observations but 99 unretained errors. Both project onto **the exact same synthetic aggregated JSON**, because the projection replaces the last group with `{otel.metric.overflow:true}` and preserves its count. Their true error rates are respectively `1/1000` and `100/1000`.

These histories demonstrate information loss within the model. They are a mathematical construction, rather than two SDK runs with byte-identical exports. The [Go SDK experiment](validation.md) uses an independently recorded workload with 34 errors among 1,000 requests and verifies that the exported counts contain that true error rate.

## Display precision and verification

Displayed percentages are truncated at six decimal places with an approximation marker when needed. Positive fractions smaller than that precision use `<0.000001%`, never `0%`. The chart uses approximate positions only, a minimum visible width for nonzero uncertainty, and exact fractions beneath it. Two equal-looking rounded endpoints do not make a result exact.

The exhaustive test enumerates `K=0..7`, `E=0..K`, `O=0..7` and thresholds `0/10..10/10`. It checks all 14,245 nonempty compatible allocations across 3,168 parameter combinations, including both endpoint witnesses and universal verdict semantics. Empty totals are checked separately within the same enumeration. This is a deterministic bounded exhaustive test, not random sampling or a snapshot assertion.
