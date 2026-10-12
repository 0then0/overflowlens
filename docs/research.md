# Design and references

OverflowLens applies a narrow model to a saved OpenTelemetry request counter. Its decisions follow the wire semantics and explicit provenance assumptions described in the [input contract](input-contract.md).

## Cardinality overflow

The [Metrics SDK specification](https://opentelemetry.io/docs/specs/otel/metrics/sdk/#cardinality-limits) defines an overflow attribute set containing only `otel.metric.overflow=true`. Synchronous measurements must be counted exactly once, without loss or double-counting. Cardinality limits apply after View attribute filtering.

Cumulative synchronous aggregation retains ordinary attribute sets observed before overflow. Delta aggregation may choose an arbitrary retained subset. OverflowLens uses the actual exported counts, includes overflow in the denominator, and leaves its outcomes unknown. It does not derive retained series from a configured limit.

## Metric and measurement identity

The [Metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/) distinguishes Resource, scope and metric name from identifying properties such as type, unit, temporality and monotonicity. Description is not identifying. Individual measurement streams are identified by their attribute sets.

OverflowLens preserves these distinctions and schema URLs. Conflicting definitions, duplicate measurement identities and malformed potentially related containers cause a refusal. Keeping only surviving records would not establish a complete export.

## Cumulative continuity

The [OTLP exporter specification](https://opentelemetry.io/docs/specs/otel/metrics/sdk_exporters/otlp/) makes cumulative temporality the default preference. Collection end times identify boundaries; unchanged known per-series starts support continuity. The model distinguishes true resets from unknown starts.

OverflowLens matches every corresponding point and checks its start and count independently. Different series starts are allowed. Missing counterparts, changed starts, decreasing counts and ambiguous collection boundaries refuse the window. Completeness and a continuous source history remain user-confirmed assumptions.

The [Collector cumulative-to-delta processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/cumulativetodeltaprocessor) maintains live state and offers initial-value policies, including an `auto` heuristic. OverflowLens uses none of those policies: it analyzes two selected saved exports without inferring a first delta or repairing missing samples.

## Exact JSON values

[OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding) uses lowerCamelCase names, numeric enums and ignored unknown fields. [ProtoJSON](https://protobuf.dev/programming-guides/json/#representation-of-each-type) permits numeric strings, finite quoted doubles, and standard or URL-safe base64 with optional padding.

Pinned [lossless-json](https://github.com/josdejong/lossless-json) 4.3.1 preserves integer tokens. Counts, timestamps and rational comparisons use BigInt. Fractional and exponent forms of integer fields are outside the supported subset. Equivalent bytes and numeric/quoted double attributes share an identity; floating-point counts are unsupported.

Parsed containers are rebuilt from their own entries before normalization. Unknown JSON properties cannot supply inherited OTLP metadata. Only genuine parser number instances are accepted as numeric tokens. Conflicting repeated object keys fail parsing; separate attribute and point duplicate checks prevent ambiguity after normalization.

## SDK overflow versus processor tagging

[Cardinality Guardian](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/cardinalityguardianprocessor) can use `tag_only` to add the same marker while retaining measurement attributes. OverflowLens refuses that additional-attribute shape as ambiguous. A single-marker point still requires a user assertion of genuine SDK origin.

## Pinned Go SDK behavior

The [Go metric SDK v1.47.0](https://pkg.go.dev/go.opentelemetry.io/otel/sdk/metric@v1.47.0), its [reader defaults](https://github.com/open-telemetry/opentelemetry-go/blob/v1.47.0/sdk/metric/reader.go), and its [cumulative Sum implementation](https://github.com/open-telemetry/opentelemetry-go/blob/v1.47.0/sdk/metric/internal/aggregate/sum.go) are exercised by the [validation harness](../validation/main.go). The cumulative implementation retains values across collections and supports per-series starts under an experimental SDK option. OverflowLens accepts either common or per-series starts when corresponding points remain continuous.

The [Go v1.47.0 limiter](https://github.com/open-telemetry/opentelemetry-go/blob/v1.47.0/sdk/metric/internal/aggregate/limit.go) reserves an overflow entry at `len(measurements) >= aggLimit-1`. With limit 3, the validation workload emits two ordinary points and overflow. This differs from the specification's no-overflow guarantee phrased in terms of non-overflow attribute sets. Exactly-at-limit behavior is outside this workload; calculations use emitted counts rather than assumptions about the limit.

The [validation guide](validation.md) describes official exporter payload capture, independent ground truth, View controls, and the scope of the compatibility evidence.
