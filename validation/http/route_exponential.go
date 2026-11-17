package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"sort"

	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
)

// Exponential route slow-share experiment. A real SDK Float64Histogram named and measured
// like http.server.request.duration, aggregated by a View as a base-2 exponential histogram,
// receives known durations directly through the Metric API. There is no HTTP server and no
// timing. An independent journal of (route, method, duration) is kept before the SDK sees
// each value, and the true slow share of the selected route is computed from that journal
// with exact rational arithmetic, never from exported buckets.

const (
	expScope    = "overflowlens.http.route.exponential.validation"
	expMaxSize  = 40 // small, so wide attribute sets downscale and points get different scales
	expMaxScale = 8
)

// Typed thresholds analyzed for every case. 0.3 s lies inside a bucket at every scale; 0.5 s
// is a bucket boundary at every scale >= 0.
var expThresholds = []string{"0.3", "0.5"}

type expTruth struct {
	Threshold          string `json:"thresholdSeconds"`
	Requests           string `json:"requests"`
	Slow               string `json:"slow"`
	ExactlyAtThreshold string `json:"exactlyAtThreshold"`
}
type expPointEvidence struct {
	Route     string `json:"route"`
	Method    string `json:"method"`
	Overflow  bool   `json:"overflow"`
	Count     uint64 `json:"count"`
	Scale     int32  `json:"scale"`
	Offset    int32  `json:"offset"`
	ZeroCount uint64 `json:"zeroCount"`
}
type expSetTally struct {
	Route    string `json:"route"`
	Method   string `json:"method"`
	Retained bool   `json:"retainedBySDK"`
	Requests int    `json:"requests"`
}
type expEvidence struct {
	Name             string             `json:"name"`
	File             string             `json:"file"`
	CardinalityLimit int                `json:"cardinalityLimit"`
	Observations     int                `json:"observations"`
	OrdinaryPoints   int                `json:"ordinaryPoints"`
	OverflowPoints   int                `json:"overflowPoints"`
	SelectedKnown    string             `json:"selectedRouteKnownRequests"`
	OverflowCount    string             `json:"overflowCount"`
	OtherRoutesKnown string             `json:"otherRoutesKnown"`
	Points           []expPointEvidence `json:"points"`
	Truth            []expTruth         `json:"truthSelectedRoute"`
	Sets             []expSetTally      `json:"journal"`
	Plan             []obs              `json:"plan"`
}
type expManifest struct {
	Go          string            `json:"go"`
	Commands    []string          `json:"commands"`
	Modules     map[string]string `json:"modules"`
	Purpose     string            `json:"purpose"`
	Metric      string            `json:"metric"`
	Unit        string            `json:"unit"`
	Temporality string            `json:"temporality"`
	Aggregation string            `json:"aggregation"`
	MaxSize     int32             `json:"maxSize"`
	MaxScale    int32             `json:"maxScale"`
	Route       string            `json:"selectedRoute"`
	Thresholds  []string          `json:"durationThresholdsSeconds"`
	Scope       string            `json:"scope"`
	Serializer  string            `json:"serializer"`
	Placement   string            `json:"bucketPlacementCheck"`
	Cases       []expEvidence     `json:"cases"`
	NotMeasured string            `json:"notMeasured"`
}

// expPlan is ordered: the first attribute sets are the ones a small limit retains. With
// includeSelected, /checkout GET is retained under a limit of 5 and /checkout POST is not.
func expPlan(includeSelected bool) []obs {
	selectedGET := []obs{
		group(selectedRoute, "GET", 0, 3), group(selectedRoute, "GET", 0.012, 50),
		group(selectedRoute, "GET", 0.045, 80), group(selectedRoute, "GET", 0.12, 100),
		group(selectedRoute, "GET", 0.2, 60), group(selectedRoute, "GET", 0.28, 30),
		group(selectedRoute, "GET", 0.3, 20), // exactly at the first threshold
		group(selectedRoute, "GET", 0.31, 15), group(selectedRoute, "GET", 0.45, 20),
		group(selectedRoute, "GET", 0.5, 25), // exactly at the second threshold
		group(selectedRoute, "GET", 0.62, 10), group(selectedRoute, "GET", 0.9, 6),
		group(selectedRoute, "GET", 1.7, 4),
	}
	var plan []obs
	if includeSelected {
		plan = append(plan, selectedGET...)
	}
	plan = append(plan,
		group("/cart", "GET", 0.02, 100), group("/cart", "GET", 1.5, 20),
		group("/search", "GET", 0.2, 60), group("/search", "GET", 0.33, 10), group("/search", "GET", 2.5, 5),
		group("/static", "GET", 0.004, 40),
		group("/health", "GET", 0, 5), group("/health", "GET", 0.001, 30))
	// After the limit: new attribute sets whose route the SDK discards.
	if !includeSelected {
		plan = append(plan, selectedGET...)
	}
	plan = append(plan,
		group(selectedRoute, "POST", 0.05, 30), group(selectedRoute, "POST", 0.29, 10),
		group(selectedRoute, "POST", 0.305, 10), group(selectedRoute, "POST", 0.5, 5),
		group(selectedRoute, "POST", 0.75, 6), group(selectedRoute, "POST", 2.2, 4),
		group("/orders", "GET", 0.05, 50), group("/orders", "GET", 1.5, 15))
	for i := 0; i < 6; i++ {
		plan = append(plan, group(fmt.Sprintf("/admin/%02d", i), "GET", 0.2, 4), group(fmt.Sprintf("/admin/%02d", i), "GET", 3, 1))
	}
	return plan
}

func runRouteExponential() error {
	out := filepath.Join("..", "fixtures", "http")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	result := expManifest{
		Go:       runtime.Version(),
		Commands: []string{"npm run validate:http-route-exponential"},
		Modules:  moduleVersions(),
		Purpose: "SDK aggregation validation of the exponential route slow-share bounds. Known durations are recorded directly through the Metric API " +
			"into a real SDK histogram with base-2 exponential aggregation; no HTTP server is involved and no wall-clock behavior is measured.",
		Metric:      metricName,
		Unit:        "s",
		Temporality: "delta (sdk.WithTemporalitySelector)",
		Aggregation: fmt.Sprintf("base-2 exponential histogram through a View (sdk.AggregationBase2ExponentialHistogram{MaxSize: %d, MaxScale: %d})", expMaxSize, expMaxScale),
		MaxSize:     expMaxSize,
		MaxScale:    expMaxScale,
		Route:       selectedRoute,
		Thresholds:  expThresholds,
		Scope:       expScope,
		Serializer:  "OTLP HTTP exporter → OTLP protobuf → protojson (UseEnumNumbers)",
		Placement: "Every exported bucket count is recomputed from the journal at the point's own scale with exact big-integer comparisons " +
			"(base^i < v <= base^(i+1)) and must match the SDK.",
		NotMeasured: "This is not a measurement of real HTTP latency. Durations are chosen constants.",
	}
	for _, c := range []struct {
		name            string
		limit           int
		includeSelected bool
	}{{"route-exp-overflow", 5, true}, {"route-exp-no-overflow", 2000, true}, {"route-exp-absent", 5, false}} {
		ev, payload, err := expExperiment(c.name, c.limit, expPlan(c.includeSelected))
		if err != nil {
			return fmt.Errorf("%s: %w", c.name, err)
		}
		if err = os.WriteFile(filepath.Join(out, ev.File), payload, 0o644); err != nil {
			return err
		}
		result.Cases = append(result.Cases, ev)
		scales := map[int32]bool{}
		for _, p := range ev.Points {
			scales[p.Scale] = true
		}
		fmt.Printf("%s: limit=%d known=%s overflow=%s other=%s ordinary=%d overflowPoints=%d scales=%d truth=%v\n", ev.File,
			ev.CardinalityLimit, ev.SelectedKnown, ev.OverflowCount, ev.OtherRoutesKnown, ev.OrdinaryPoints, ev.OverflowPoints, len(scales), ev.Truth)
	}
	b, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "route-exp-manifest.json"), append(b, '\n'), 0o644)
}

// exactIndex returns the bucket index i of v > 0 at the given scale, with
// 2^(i/2^scale) < v <= 2^((i+1)/2^scale), checked exactly: raising both sides to the
// power 2^scale (scale >= 0) keeps the order, and for scale < 0 every bound is a power of two.
func exactIndex(v float64, scale int32) int64 {
	r := new(big.Rat).SetFloat64(v)
	num, den := r.Num(), r.Denom()
	// sign(2^(k/2^scale) - v)
	cmp := func(k int64) int {
		var p int64 = 1
		e := k
		if scale >= 0 {
			p = 1 << scale
		} else {
			e = k << (-scale)
		}
		left := new(big.Int).Exp(den, big.NewInt(p), nil)
		right := new(big.Int).Exp(num, big.NewInt(p), nil)
		if e >= 0 {
			left.Lsh(left, uint(e))
		} else {
			right.Lsh(right, uint(-e))
		}
		return left.Cmp(right)
	}
	i := int64(math.Ceil(math.Log2(v)*math.Ldexp(1, int(scale)))) - 1
	for cmp(i) >= 0 { // the lower bound must be below v
		i--
	}
	for cmp(i+1) < 0 { // the upper bound must reach v
		i++
	}
	return i
}

func expExperiment(name string, limit int, plan []obs) (expEvidence, []byte, error) {
	ctx := context.Background()
	ev := expEvidence{Name: name, File: name + ".json", CardinalityLimit: limit, Plan: plan}
	reader := sdk.NewManualReader(sdk.WithTemporalitySelector(func(sdk.InstrumentKind) metricdata.Temporality {
		return metricdata.DeltaTemporality
	}))
	provider := sdk.NewMeterProvider(
		sdk.WithReader(reader),
		sdk.WithCardinalityLimit(limit),
		sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", "overflowlens-route-exponential-validation"))),
		sdk.WithView(sdk.NewView(sdk.Instrument{Name: metricName}, sdk.Stream{
			Aggregation: sdk.AggregationBase2ExponentialHistogram{MaxSize: expMaxSize, MaxScale: expMaxScale},
		})),
	)
	defer provider.Shutdown(ctx)
	histogram, err := provider.Meter(expScope).Float64Histogram(metricName, otelmetric.WithUnit("s"))
	if err != nil {
		return ev, nil, err
	}
	var baseline metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &baseline); err != nil {
		return ev, nil, err
	}

	// Independent journal, written before each value reaches the SDK.
	journal := map[setKey][]float64{}
	var order []setKey
	for _, g := range plan {
		k := setKey{g.Route, g.Method}
		if _, ok := journal[k]; !ok {
			order = append(order, k)
		}
		for i := 0; i < g.Count; i++ {
			journal[k] = append(journal[k], g.Seconds)
			histogram.Record(ctx, g.Seconds, otelmetric.WithAttributes(
				attribute.String("http.route", g.Route), attribute.String("http.request.method", g.Method)))
			ev.Observations++
		}
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &rm); err != nil {
		return ev, nil, err
	}
	var hist *metricdata.ExponentialHistogram[float64]
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != metricName {
				continue
			}
			h, ok := m.Data.(metricdata.ExponentialHistogram[float64])
			if !ok || h.Temporality != metricdata.DeltaTemporality || m.Unit != "s" {
				return ev, nil, fmt.Errorf("unexpected %s definition: %T unit=%q", metricName, m.Data, m.Unit)
			}
			hist = &h
		}
	}
	if hist == nil {
		return ev, nil, fmt.Errorf("%s was not exported", metricName)
	}

	// The buckets the journal values must occupy at a given scale.
	expected := func(values []float64, scale int32) (map[int64]uint64, uint64) {
		buckets := map[int64]uint64{}
		var zero uint64
		for _, v := range values {
			if v == 0 {
				zero++
				continue
			}
			buckets[exactIndex(v, scale)]++
		}
		return buckets, zero
	}
	compareBuckets := func(label string, p metricdata.ExponentialHistogramDataPoint[float64], values []float64) error {
		want, zero := expected(values, p.Scale)
		if p.ZeroCount != zero {
			return fmt.Errorf("%s: zero count SDK %d, journal %d", label, p.ZeroCount, zero)
		}
		if len(p.NegativeBucket.Counts) != 0 {
			for _, c := range p.NegativeBucket.Counts {
				if c != 0 {
					return fmt.Errorf("%s: negative buckets are not empty", label)
				}
			}
		}
		got := map[int64]uint64{}
		for i, c := range p.PositiveBucket.Counts {
			if c != 0 {
				got[int64(p.PositiveBucket.Offset)+int64(i)] = c
			}
		}
		for i, c := range want {
			if got[i] != c {
				return fmt.Errorf("%s at scale %d: bucket %d SDK %d, exact journal placement %d", label, p.Scale, i, got[i], c)
			}
		}
		if len(got) != len(want) {
			return fmt.Errorf("%s at scale %d: SDK has %d non-empty buckets, journal %d", label, p.Scale, len(got), len(want))
		}
		return nil
	}

	retained := map[setKey]bool{}
	var known, overflowCount, other uint64
	var overflowPoint *metricdata.ExponentialHistogramDataPoint[float64]
	for i := range hist.DataPoints {
		point := hist.DataPoints[i]
		if v, ok := point.Attributes.Value(overflow); ok {
			if v.Type() != attribute.BOOL || !v.AsBool() || point.Attributes.Len() != 1 {
				return ev, nil, fmt.Errorf("non-SDK overflow shape")
			}
			ev.OverflowPoints++
			overflowCount += point.Count
			overflowPoint = &point
			ev.Points = append(ev.Points, expPointEvidence{Overflow: true, Count: point.Count, Scale: point.Scale,
				Offset: point.PositiveBucket.Offset, ZeroCount: point.ZeroCount})
			continue
		}
		route, ok := point.Attributes.Value("http.route")
		method, ok2 := point.Attributes.Value("http.request.method")
		if !ok || !ok2 || route.Type() != attribute.STRING {
			return ev, nil, fmt.Errorf("ordinary point without a string route")
		}
		k := setKey{route.AsString(), method.AsString()}
		retained[k] = true
		ev.OrdinaryPoints++
		if err := compareBuckets(fmt.Sprint(k), point, journal[k]); err != nil {
			return ev, nil, err
		}
		if k.route == selectedRoute {
			known += point.Count
		} else {
			other += point.Count
		}
		ev.Points = append(ev.Points, expPointEvidence{Route: k.route, Method: k.method, Count: point.Count, Scale: point.Scale,
			Offset: point.PositiveBucket.Offset, ZeroCount: point.ZeroCount})
	}
	// The overflow must hold exactly the journal of every attribute set the SDK did not retain.
	var lost []float64
	for _, k := range order {
		if !retained[k] {
			lost = append(lost, journal[k]...)
		}
	}
	if overflowPoint != nil {
		if err := compareBuckets("overflow", *overflowPoint, lost); err != nil {
			return ev, nil, err
		}
	} else if len(lost) != 0 {
		return ev, nil, fmt.Errorf("%d observations lost without an overflow point", len(lost))
	}
	if int(known+other+overflowCount) != ev.Observations {
		return ev, nil, fmt.Errorf("SDK conservation failed")
	}

	// Truth from the journal alone: exact rational comparison of each recorded value.
	for _, text := range expThresholds {
		d, ok := new(big.Rat).SetString(text)
		if !ok {
			return ev, nil, fmt.Errorf("bad threshold %q", text)
		}
		var requests, slow, at int
		for _, k := range order {
			if k.route != selectedRoute {
				continue
			}
			for _, v := range journal[k] {
				requests++
				switch new(big.Rat).SetFloat64(v).Cmp(d) {
				case 1:
					slow++
				case 0:
					at++
				}
			}
		}
		ev.Truth = append(ev.Truth, expTruth{text, fmt.Sprint(requests), fmt.Sprint(slow), fmt.Sprint(at)})
	}

	for _, k := range order {
		t := expSetTally{Route: k.route, Method: k.method, Retained: retained[k], Requests: len(journal[k])}
		ev.Sets = append(ev.Sets, t)
	}
	sort.Slice(ev.Sets, func(i, j int) bool {
		if ev.Sets[i].Route != ev.Sets[j].Route {
			return ev.Sets[i].Route < ev.Sets[j].Route
		}
		return ev.Sets[i].Method < ev.Sets[j].Method
	})
	sort.Slice(ev.Points, func(i, j int) bool {
		a, b := ev.Points[i], ev.Points[j]
		if a.Overflow != b.Overflow {
			return !a.Overflow
		}
		if a.Route != b.Route {
			return a.Route < b.Route
		}
		return a.Method < b.Method
	})
	switch name {
	case "route-exp-overflow":
		if overflowCount == 0 || known == 0 || !retained[setKey{selectedRoute, "GET"}] || retained[setKey{selectedRoute, "POST"}] {
			return ev, nil, fmt.Errorf("the small limit did not produce the intended retained/overflow split")
		}
	case "route-exp-no-overflow":
		if overflowCount != 0 || ev.OverflowPoints != 0 {
			return ev, nil, fmt.Errorf("the large limit still overflowed")
		}
	case "route-exp-absent":
		if known != 0 || overflowCount == 0 {
			return ev, nil, fmt.Errorf("the selected route was unexpectedly retained")
		}
	}
	ev.SelectedKnown, ev.OverflowCount, ev.OtherRoutesKnown = fmt.Sprint(known), fmt.Sprint(overflowCount), fmt.Sprint(other)
	payload, err := exportPayload(ctx, &rm)
	return ev, payload, err
}
