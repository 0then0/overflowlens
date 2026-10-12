# Input contract

This reference defines the saved OTLP data that OverflowLens can analyze. Start with the [README](../README.md) for the application workflow.

## Files and representation

Import uncompressed UTF-8 JSON `ExportMetricsServiceRequest` files. Delta mode uses one file; cumulative mode uses two separate Before and After exports. Each file is limited to **5 MiB**, and a pair to **10 MiB combined**. Size checks occur before reading.

Use OTLP lowerCamelCase field names, such as `resourceMetrics`, `scopeMetrics`, `dataPoints`, `asInt`, `startTimeUnixNano` and `timeUnixNano`. Enum values must be numeric. Integer fields accept decimal strings or JSON numeric integer tokens, preserving all digits. Fractional and exponent forms of integer fields are unsupported.

Invalid JSON and conflicting duplicate object keys fail parsing. Identical repeated key/value pairs are coalesced by the parser; duplicate point identities and attribute keys are checked separately. Unknown fields are ignored and cannot supply recognized metadata through inherited properties.

Imports use a separate cancellable Worker for each side, at most one active Worker per side. Replacing a file terminates its Worker and ignores stale read/hash results. Raw text is not retained after import. The byte limits bound input size; parsing, hashing and Worker cloning require additional temporary memory.

## Stream identity

Resource attributes, scope name/version/attributes, schema URLs and metric name identify a stream group. Attribute order is irrelevant. Within that group, type, unit, temporality and monotonicity must agree. Description is not identifying. Schema URLs are preserved without schema translation.

Resource and scope `droppedAttributesCount` must be zero or absent. A malformed repeated Resource or scope blocks streams with its recognizable identity. If its identity cannot be established, the refusal extends to potentially related streams: an unidentified scope affects its Resource, and an unidentified Resource can affect all streams in the file. Independent recognized streams remain usable, with import diagnostics retained.

Conflicting definitions, duplicate measurement identities and malformed potentially related containers block the selected stream. Related data is never silently dropped to produce a partial verdict.

## Counter and outcome

Both modes require a synchronous request counter represented as a monotonic integer `Sum`:

- Delta: `aggregationTemporality: 1`.
- Cumulative: `aggregationTemporality: 2`.
- Both: `isMonotonic: true`.

Counts must use `asInt` and be nonnegative signed int64. Individual counts must fit OTLP int64; calculated totals use unbounded BigInt and may exceed it. Non-monotonic sums, other metric types and `asDouble` counts are unsupported, including integral-valued doubles. Point flags must be zero or absent; missing-observation and unknown flags are unsupported.

Choose a measurement outcome key and whether `true` or `false` means error. Every ordinary point must contain that key as `boolValue`. Resource and scope attributes cannot supply it. The outcome key cannot be `otel.metric.overflow`.

The wire format cannot establish synchrony or request-count meaning. These are part of the provenance confirmation.

## Delta interval

Every point needs unsigned int64 timestamps satisfying `0 < startTimeUnixNano < timeUnixNano`. Exactly equal start/end boundaries form one selectable interval. Adjacent or disjoint intervals remain separate; overlapping unequal intervals invalidate the stream. Intervals are never summed.

At least one timestamped point is required, even for a zero counter. Measurement attribute sets must be unique within an interval. Repeated exports are refused rather than silently deduplicated. A cumulative snapshot cannot be analyzed as a delta interval.

## Cumulative window

Select one matching stream from each full export. Each selected stream must have exactly one collection timestamp shared by all its points. Multiple collection timestamps are unsupported because selecting a subset could hide points from a partial export.

The Before collection timestamp must be strictly earlier than After. The analyzed window is `(before, after]`.

A supported pair has:

1. Identical canonical Resource/scope/metric identities, schema URLs, type, unit, temporality and monotonicity.
2. Identical sets of unique measurement attribute identities, including overflow when present. Attribute order is irrelevant.
3. A known start for each series, satisfying `0 < start < before`, unchanged between its corresponding points. Different series may have different starts.
4. Valid nonnegative integer counts and `afterCount >= beforeCount` for every matched point.
5. The selected boolean outcome on ordinary points and the SDK overflow shape below.

A changed start or decreasing point refuses the entire window, even if the total increases. New or missing identities are unsupported: there is no zero substitution, intersection or inferred first sample. The model does not cover resets or changes to ordinary attribution.

Subtract each matched point exactly, then sum ordinary increments K, ordinary error increments E, and overflow increment O. Baseline observations are excluded. The same bounds and threshold rules apply to these increments; snapshot percentages and bounds are never subtracted.

Structural applicability is checked before provenance confirmation. Pairing and aggregation are reused while only the threshold or confirmation changes. File, stream, boundary, outcome key or error-value changes invalidate that preparation.

## Attribute values

Keys must be nonempty and unique within each attribute set. Each AnyValue contains exactly one recognized type:

- `boolValue`: a JSON boolean.
- `stringValue`: a string.
- `intValue`: an exact signed int64, with the decimal-integer restrictions above.
- `doubleValue`: a finite JSON number or quoted JSON numeric representation, including exponent notation. Equivalent numeric and quoted representations share an identity. Malformed and nonfinite values are rejected.
- `bytesValue`: valid standard or URL-safe base64, with optional padding. Equivalent encodings share an identity; empty bytes are valid.
- `arrayValue`: recursively validated values, with significant array order.
- `kvlistValue`: recursively validated key/value entries, with insignificant entry order.

These rules apply to Resource, scope and measurement attributes. Auxiliary double-valued attributes are supported; floating-point request counts are not.

## SDK overflow and provenance

SDK overflow must have exactly one measurement attribute:

```json
{"key":"otel.metric.overflow","value":{"boolValue":true}}
```

False, string and numeric markers are invalid. Additional measurement attributes produce `AMBIGUOUS_OVERFLOW`, because the shape can represent processor tagging rather than SDK attribution loss. Multiple overflow points within one interval or snapshot are duplicate measurement identities. Exemplars are samples and do not establish all overflow outcomes.

The single-marker shape does not establish SDK origin. Confirm that the selected interval, or both snapshots, are complete SDK exports of a synchronous request counter, with one boolean outcome per request and no downstream changes to counts or measurement attribution. Cumulative mode also requires one continuous source history, unchanged per-series starts and stable ordinary attribution.

These are user assumptions. Matching metadata and source hashes cannot prove completeness, authenticity or continuity.

## Results and diagnostics

- `WITHIN_LIMIT`: every compatible allocation meets the maximum allowed rate.
- `EXCEEDS_LIMIT`: every compatible allocation exceeds it.
- `INDETERMINATE`: compatible allocations exist on both sides of the limit.
- `NO_DATA`: a valid timestamped interval or window totals zero; an error rate is undefined.
- `INVALID_INPUT`: malformed or contradictory data.
- `UNSUPPORTED_INPUT`: data outside the model or unconfirmed provenance.

Refusals contain a diagnostic code, explanation and path when available. They are distinct from mathematical uncertainty. A structurally applicable pair can still be refused for unconfirmed provenance or an invalid threshold. See [mathematics](mathematics.md) for exact decisions and endpoint witnesses.

## Reports and state

Delta schema v1 preserves `source`, `identity`, `interval`, `settings`, `assumptions`, `model`, `result`, `witnesses` and `limitations`. It includes source name, original-byte size/SHA-256, exact boundaries, decimal-string counts and fractions, point counts and attainable endpoint witnesses.

Cumulative schema v2 adds `mode: cumulative`, `sources.before`, `sources.after`, `selectedInputs` for both identities/snapshot IDs, and `window` with exact collection boundaries. `applicability` records the checks and matched-point count. Each entry in `result.points` contains canonical attributes, `startTimeUnixNano`, `beforeCount`, `afterCount` and `count`, where `count` is the window increment. Counts and timestamps are decimal strings; those increments replay K/E/O/T.

Cumulative refusals retain both sources, selected identities, selected boundaries and diagnostics, without invented totals, fractions or witnesses. Reports do not contain complete raw exports. Point and key order is deterministic for equivalent selections and identical source metadata; different source bytes still produce different hashes.

Source SHA-256 identifies original file bytes, including an optional UTF-8 BOM. It does not authenticate them. Application state stays in browser memory. Input or outcome changes clear dependent settings, provenance confirmation and the previous verdict. UI and reports use the same exact calculation.
