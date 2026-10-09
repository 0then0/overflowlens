# Design and references

OverflowLens applies a narrow model to an imported OpenTelemetry request counter. This page explains the specification choices behind that model and links to their primary sources. For accepted inputs, see the [input contract](input-contract.md).

## Cardinality overflow

The [Metrics SDK specification](https://opentelemetry.io/docs/specs/otel/metrics/sdk/#cardinality-limits) defines an overflow attribute set containing only the boolean marker `otel.metric.overflow=true`. Synchronous measurements must be counted exactly once, without loss or double-counting. Cardinality limits apply after View attribute filtering, and a delta aggregation may retain an arbitrary subset of ordinary attribute sets.

Consequently, OverflowLens includes overflow in the total but treats every overflow outcome as unknown. It does not infer which attribute combinations survived. The [OpenTelemetry cardinality guide](https://opentelemetry.io/blog/2026/cardinality-limits-in-opentelemetry/) explains why measurement attributes can disappear while counts and separate Resource/scope metadata remain available.

## Metric identity

The [Metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/) distinguishes Resource, scope and metric name from identifying properties such as type, unit, temporality and monotonicity. Description is not identifying. OverflowLens preserves these distinctions, keeps schema URLs, and rejects conflicting definitions, duplicate points and overlapping unequal intervals instead of guessing how to merge them.

If a damaged container cannot be distinguished from part of the selected stream, the application refuses a conclusion. Reporting a valid fraction from only the surviving records would not establish a complete interval.

## JSON representation and exact values

[OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding) uses lowerCamelCase names, numeric enum values and ignored unknown fields. The underlying [ProtoJSON representation](https://protobuf.dev/programming-guides/json/#representation-of-each-type) permits numeric strings, finite quoted doubles, and standard or URL-safe base64 with optional padding.

OverflowLens preserves integer tokens with pinned [lossless-json](https://github.com/josdejong/lossless-json) 4.3.1 and performs counts and rational comparisons with `BigInt`. Integer fields intentionally accept only decimal integer representations; fractional and exponent forms are outside the supported subset.

Equivalent bytes and numeric/quoted double attributes share an identity. Only genuine parser number instances are accepted as numeric tokens. Parsed containers are rebuilt from their own entries before normalization, preventing inherited properties from supplying OTLP metadata. The parser rejects conflicting repeated object keys and coalesces identical key/value repeats; independent point and attribute duplicate checks remain necessary.

## SDK overflow versus processor tagging

[Cardinality Guardian](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/cardinalityguardianprocessor) can use `tag_only` to add the same overflow marker while retaining the original measurement attributes. OverflowLens rejects that shape as ambiguous.

A single-marker point still does not prove SDK origin. Provenance is a user-confirmed assumption. Guardian behavior informs the refusal rule; the project does not claim an executed Guardian compatibility test.

## Pinned Go SDK experiment

[Go metric SDK v1.47.0](https://pkg.go.dev/go.opentelemetry.io/otel/sdk/metric@v1.47.0) supplies `WithCardinalityLimit`, `NewManualReader`, `WithTemporalitySelector` and `NewView`. The [validation harness](../validation/main.go) exercises these APIs and the official HTTP exporter.

The [Go v1.47.0 limiter](https://github.com/open-telemetry/opentelemetry-go/blob/v1.47.0/sdk/metric/internal/aggregate/limit.go) reserves an entry for overflow at `len(measurements) >= aggLimit-1`. With limit 3, the validation workload emits two ordinary points plus overflow. This differs from the specification's stated no-overflow guarantee up to the configured number of non-overflow attribute sets. An exactly-at-limit workload is outside the current experiment.

OverflowLens therefore uses the actual exported counts and never derives retained series or overflow from a configured limit. The [SDK validation guide](validation.md) describes the workload, independent ground truth and limitations.
