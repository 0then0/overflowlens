# Input contract

Use this reference to determine whether an OTLP export can support an OverflowLens calculation. For an introduction and local setup, start with the [README](../README.md).

## File format

Import one uncompressed UTF-8 JSON `ExportMetricsServiceRequest`, at most 5 MiB. Use OTLP lowerCamelCase field names, such as `resourceMetrics`, `scopeMetrics`, `dataPoints`, `asInt`, `startTimeUnixNano` and `timeUnixNano`. Enum values must be numeric, as required by OTLP JSON.

Unknown fields are ignored and cannot supply inherited properties to recognized OTLP objects. Invalid JSON and conflicting duplicate object keys fail parsing. The lossless parser coalesces identical repeated key/value pairs; separate metric-point and attribute-key checks still reject ambiguous duplicates.

## Stream identity and complete intervals

Resource attributes, scope name/version/attributes, schema URLs and metric name identify a metric group. Attribute order is irrelevant. Within that group, type, unit, temporality and monotonicity must agree. Description is not an identifying property. Schema URLs are preserved without translating between schemas.

Resource and scope `droppedAttributesCount` must be zero or absent. Dropped identity attributes prevent a reliable calculation. A malformed repeated Resource or scope blocks streams with its recognizable identity, regardless of whether the damaged record appears first or last. If its identity cannot be established, refusal extends to potentially related streams: an unidentified scope affects its Resource, and an unidentified Resource can affect all streams in the file. Errors remain available in import diagnostics. Independent recognized streams remain usable.

Every point needs unsigned int64 timestamps satisfying `0 < startTimeUnixNano < timeUnixNano`. Exactly equal boundaries form one selectable interval. Adjacent or disjoint intervals remain separate; overlapping unequal boundaries invalidate the stream. Intervals are never summed.

At least one timestamped point is required, even for a zero counter. Within each interval, measurement attribute sets must be unique by semantic value, independently of order. Repeated exports are rejected rather than silently deduplicated.

## Counter and outcome

The selected metric must have:

```json
{"sum":{"isMonotonic":true,"aggregationTemporality":1}}
```

It must represent a synchronous request counter. The wire format does not establish instrument synchrony or request-count meaning; those belong to the provenance confirmation.

Counts must use `asInt` and be nonnegative signed int64. Decimal strings and JSON numeric integer tokens are preserved exactly, including values above JavaScript's safe integer range. Fractional and exponent representations of integer fields are deliberately unsupported. Sums may exceed int64 because calculation uses unbounded `BigInt`.

Cumulative and non-monotonic sums, other metric types, `asDouble` counts, nonzero point flags and missing interval boundaries do not support a calculation. `asDouble` remains unsupported even when its value is integral.

Choose a measurement outcome key explicitly and select whether `true` or `false` means error. Every ordinary point must carry that key as `boolValue`. Resource and scope attributes do not satisfy this requirement. The outcome key cannot be `otel.metric.overflow`.

## Attribute values

Attribute keys must be nonempty and unique within their set. Each AnyValue must contain exactly one recognized type:

- `boolValue`: a JSON boolean.
- `stringValue`: a string.
- `intValue`: an exact signed int64, using the same decimal-integer restrictions as counts.
- `doubleValue`: a finite JSON number or quoted JSON numeric representation, including exponent notation. Both representations normalize to the same double value. Empty strings, malformed numbers and nonfinite values are rejected.
- `bytesValue`: valid standard or URL-safe base64, with or without padding. Equivalent encodings normalize to the same byte identity. Empty bytes are valid.
- `arrayValue` and `kvlistValue`: recursively validated values; array order matters and key/value-list order does not.

These rules apply to Resource, scope and measurement attributes. Auxiliary double-valued attributes are supported; floating-point request counts are not.

## SDK overflow and provenance

An overflow point must have exactly one measurement attribute:

```json
{"key":"otel.metric.overflow","value":{"boolValue":true}}
```

False, string or numeric markers are invalid. Additional measurement attributes produce `AMBIGUOUS_OVERFLOW`, because the shape may come from Cardinality Guardian tagging rather than SDK attribution loss. Multiple overflow points within one interval are duplicate measurement identities.

The single-marker shape alone does not establish SDK origin. Before calculating, confirm that the selected interval is a complete export from a synchronous SDK request counter, before count-changing or attribute-changing transformations, with one boolean outcome per request. The report records this as a user assumption, not a proven property.

## Results and diagnostics

- `WITHIN_LIMIT`: every compatible error allocation meets the maximum allowed rate.
- `EXCEEDS_LIMIT`: every compatible allocation exceeds it.
- `INDETERMINATE`: the valid interval permits allocations on both sides of the limit.
- `NO_DATA`: a valid timestamped interval totals zero; fractions and a threshold verdict are undefined.
- `INVALID_INPUT`: malformed or contradictory data.
- `UNSUPPORTED_INPUT`: data outside the model or unconfirmed provenance.

Refusals include a diagnostic code, explanation and path when available. They are distinct from mathematical uncertainty. See [mathematics](mathematics.md) for the decision rules.

## Exported report

Report version 1 contains source name, UTF-8 byte count, SHA-256, canonical stream identity, Unix-nanosecond boundaries, outcome settings, exact threshold and endpoint fractions, point counts, totals, formulas and endpoint witnesses. BigInts are serialized as decimal strings. A refusal report contains its diagnostic instead of invented counts or fractions.

The hash identifies the original file bytes; it does not prove provenance. Application state lives in browser memory. Replacing a file cancels its Worker and ignores stale read/hash results. Changing the file, stream, interval or outcome resets dependent settings. Visible and exported conclusions use the same core calculation.
