package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"

	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
)

// Route slow-share experiment. A real SDK Histogram named and measured like
// http.server.request.duration receives known durations directly through the Metric API.
// There is no HTTP server, no timing and no waiting: this validates SDK aggregation and the
// OverflowLens arithmetic, not the latency of any real service. An independent journal of
// (route, method, duration) is kept before the SDK sees each value.

const (
	routeScope     = "overflowlens.http.route.validation"
	selectedRoute  = "/checkout"
	thresholdValue = 0.5 // an explicit bucket boundary; an observation equal to it is fast
)

var routeBounds = []float64{0.1, 0.25, 0.5, 1, 2.5}

// obs is a group of identical observations. The journal expands it one value at a time.
type obs struct {
	Route   string  `json:"route"`
	Method  string  `json:"method"`
	Seconds float64 `json:"seconds"`
	Count   int     `json:"count"`
}
type setKey struct{ route, method string }
type setTally struct {
	Route       string `json:"route"`
	Method      string `json:"method"`
	Retained    bool   `json:"retainedBySDK"`
	Requests    int    `json:"requests"`
	Fast        int    `json:"notSlower"`
	Slow        int    `json:"slower"`
	AtThreshold int    `json:"exactlyAtThreshold"`
}
type routeTruth struct {
	Requests    string `json:"requests"`
	Slow        string `json:"slow"`
	AtThreshold string `json:"exactlyAtThreshold"`
}
type routeEvidence struct {
	Name             string     `json:"name"`
	File             string     `json:"file"`
	CardinalityLimit int        `json:"cardinalityLimit"`
	Observations     int        `json:"observations"`
	K                string     `json:"K"`
	E                string     `json:"E"`
	F                string     `json:"F"`
	S                string     `json:"S"`
	OtherRoutes      string     `json:"otherRoutesKnown"`
	OrdinaryPoints   int        `json:"ordinaryPoints"`
	OverflowPoints   int        `json:"overflowPoints"`
	Truth            routeTruth `json:"truthSelectedRoute"`
	Sets             []setTally `json:"journal"`
	Plan             []obs      `json:"plan"`
}
type routeManifest struct {
	Go          string            `json:"go"`
	Commands    []string          `json:"commands"`
	Modules     map[string]string `json:"modules"`
	Purpose     string            `json:"purpose"`
	Metric      string            `json:"metric"`
	Unit        string            `json:"unit"`
	Temporality string            `json:"temporality"`
	Aggregation string            `json:"aggregation"`
	Bounds      []float64         `json:"explicitBounds"`
	Route       string            `json:"selectedRoute"`
	Threshold   float64           `json:"durationThresholdSeconds"`
	Scope       string            `json:"scope"`
	Serializer  string            `json:"serializer"`
	Cases       []routeEvidence   `json:"cases"`
	NotMeasured string            `json:"notMeasured"`
}

func group(route, method string, seconds float64, count int) obs {
	return obs{route, method, seconds, count}
}

// routePlan is ordered: the first attribute sets are the ones a small limit retains.
// With includeSelected the route is recorded under GET before the limit is reached, and
// under POST after it. Without it, every request of the route arrives after the limit.
func routePlan(includeSelected bool) []obs {
	var plan []obs
	if includeSelected {
		plan = append(plan,
			group(selectedRoute, "GET", 0.05, 200), group(selectedRoute, "GET", 0.2, 150),
			group(selectedRoute, "GET", 0.5, 40), // exactly at the threshold
			group(selectedRoute, "GET", 0.75, 6), group(selectedRoute, "GET", 3, 4))
	}
	plan = append(plan,
		group("/cart", "GET", 0.05, 100), group("/cart", "GET", 1.5, 20),
		group("/search", "GET", 0.2, 60), group("/search", "GET", 0.5, 10), group("/search", "GET", 2.5, 5),
		group("/static", "GET", 0.05, 40),
		group("/health", "GET", 0.05, 30))
	// After the limit: new attribute sets whose route the SDK discards.
	if !includeSelected {
		plan = append(plan,
			group(selectedRoute, "GET", 0.05, 200), group(selectedRoute, "GET", 0.2, 150),
			group(selectedRoute, "GET", 0.5, 40), group(selectedRoute, "GET", 0.75, 6), group(selectedRoute, "GET", 3, 4))
	}
	plan = append(plan,
		group(selectedRoute, "POST", 0.05, 30), group(selectedRoute, "POST", 0.2, 40),
		group(selectedRoute, "POST", 0.5, 20), group(selectedRoute, "POST", 0.75, 6), group(selectedRoute, "POST", 3, 4),
		group("/orders", "GET", 0.05, 50), group("/orders", "GET", 1.5, 15))
	for i := 0; i < 6; i++ {
		plan = append(plan, group(fmt.Sprintf("/admin/%02d", i), "GET", 0.2, 4), group(fmt.Sprintf("/admin/%02d", i), "GET", 3, 1))
	}
	return plan
}

func moduleVersions() map[string]string {
	modules := map[string]string{}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			switch dep.Path {
			case "go.opentelemetry.io/otel", "go.opentelemetry.io/otel/metric", "go.opentelemetry.io/otel/sdk",
				"go.opentelemetry.io/otel/sdk/metric", "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp",
				"go.opentelemetry.io/proto/otlp", "google.golang.org/protobuf":
				modules[dep.Path] = dep.Version
			}
		}
	}
	return modules
}

func runRoute() error {
	out := filepath.Join("..", "fixtures", "http")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	result := routeManifest{
		Go:       runtime.Version(),
		Commands: []string{"npm run validate:http-route"},
		Modules:  moduleVersions(),
		Purpose: "SDK aggregation validation of the route slow-share bounds. Known durations are recorded directly through the Metric API " +
			"into a real SDK Histogram; no HTTP server is involved and no wall-clock behavior is measured.",
		Metric:      metricName,
		Unit:        "s",
		Temporality: "delta (sdk.WithTemporalitySelector)",
		Aggregation: "explicit bucket histogram with the instrument's explicit boundaries (metric.WithExplicitBucketBoundaries); no views",
		Bounds:      routeBounds,
		Route:       selectedRoute,
		Threshold:   thresholdValue,
		Scope:       routeScope,
		Serializer:  "OTLP HTTP exporter → OTLP protobuf → protojson (UseEnumNumbers)",
		NotMeasured: "This is not a measurement of real HTTP latency. Durations are chosen constants.",
	}
	for _, c := range []struct {
		name            string
		limit           int
		includeSelected bool
	}{{"route-overflow", 5, true}, {"route-no-overflow", 2000, true}, {"route-absent", 5, false}} {
		ev, payload, err := routeExperiment(c.name, c.limit, routePlan(c.includeSelected), c.includeSelected)
		if err != nil {
			return fmt.Errorf("%s: %w", c.name, err)
		}
		if err = os.WriteFile(filepath.Join(out, ev.File), payload, 0o644); err != nil {
			return err
		}
		result.Cases = append(result.Cases, ev)
		fmt.Printf("%s: limit=%d K=%s E=%s F=%s S=%s other=%s truth=%s slow of %s ordinary=%d overflow=%d\n", ev.File,
			ev.CardinalityLimit, ev.K, ev.E, ev.F, ev.S, ev.OtherRoutes, ev.Truth.Slow, ev.Truth.Requests, ev.OrdinaryPoints, ev.OverflowPoints)
	}
	b, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "route-manifest.json"), append(b, '\n'), 0o644)
}

// bucketOf is deliberately written differently from the SDK: upper bounds are inclusive.
func bucketOf(v float64) int {
	i := 0
	for i < len(routeBounds) && v > routeBounds[i] {
		i++
	}
	return i
}

func routeExperiment(name string, limit int, plan []obs, wantSelectedRetained bool) (routeEvidence, []byte, error) {
	ctx := context.Background()
	ev := routeEvidence{Name: name, File: name + ".json", CardinalityLimit: limit, Plan: plan}
	reader := sdk.NewManualReader(sdk.WithTemporalitySelector(func(sdk.InstrumentKind) metricdata.Temporality {
		return metricdata.DeltaTemporality
	}))
	provider := sdk.NewMeterProvider(
		sdk.WithReader(reader),
		sdk.WithCardinalityLimit(limit),
		sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", "overflowlens-route-validation"))),
	)
	defer provider.Shutdown(ctx)
	histogram, err := provider.Meter(routeScope).Float64Histogram(metricName,
		otelmetric.WithUnit("s"), otelmetric.WithExplicitBucketBoundaries(routeBounds...))
	if err != nil {
		return ev, nil, err
	}
	var baseline metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &baseline); err != nil {
		return ev, nil, err
	}

	// Independent journal, written before each value reaches the SDK.
	journal := map[setKey][]int{} // per attribute set: counts per bucket
	for _, g := range plan {
		for i := 0; i < g.Count; i++ {
			k := setKey{g.Route, g.Method}
			if journal[k] == nil {
				journal[k] = make([]int, len(routeBounds)+1)
			}
			journal[k][bucketOf(g.Seconds)]++
			histogram.Record(ctx, g.Seconds, otelmetric.WithAttributes(
				attribute.String("http.route", g.Route), attribute.String("http.request.method", g.Method)))
			ev.Observations++
		}
	}
	atThreshold := map[setKey]int{}
	for _, g := range plan {
		if g.Seconds == thresholdValue {
			atThreshold[setKey{g.Route, g.Method}] += g.Count
		}
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &rm); err != nil {
		return ev, nil, err
	}
	var hist *metricdata.Histogram[float64]
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != metricName {
				continue
			}
			h, ok := m.Data.(metricdata.Histogram[float64])
			if !ok || h.Temporality != metricdata.DeltaTemporality || m.Unit != "s" {
				return ev, nil, fmt.Errorf("unexpected %s definition: %T unit=%q", metricName, m.Data, m.Unit)
			}
			hist = &h
		}
	}
	if hist == nil {
		return ev, nil, fmt.Errorf("%s was not exported", metricName)
	}

	slowFrom := -1 // first slow bucket: everything after the bucket that ends at the threshold
	for i, b := range routeBounds {
		if b == thresholdValue {
			slowFrom = i + 1
		}
	}
	if slowFrom < 0 {
		return ev, nil, fmt.Errorf("threshold %v is not an explicit bound", thresholdValue)
	}
	var K, E, F, S, other uint64
	retained := map[setKey]bool{}
	overflowBuckets := make([]uint64, len(routeBounds)+1)
	for _, point := range hist.DataPoints {
		if len(point.Bounds) != len(routeBounds) {
			return ev, nil, fmt.Errorf("unexpected bounds %v", point.Bounds)
		}
		var slow uint64
		for i := slowFrom; i < len(point.BucketCounts); i++ {
			slow += point.BucketCounts[i]
		}
		if v, ok := point.Attributes.Value(overflow); ok {
			if v.Type() != attribute.BOOL || !v.AsBool() || point.Attributes.Len() != 1 {
				return ev, nil, fmt.Errorf("non-SDK overflow shape")
			}
			ev.OverflowPoints++
			F += point.Count - slow
			S += slow
			for i, c := range point.BucketCounts {
				overflowBuckets[i] += c
			}
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
		// The SDK output must reproduce the independent journal of this attribute set.
		for i, c := range point.BucketCounts {
			if int(c) != journal[k][i] {
				return ev, nil, fmt.Errorf("bucket %d of %v: SDK %d, journal %d", i, k, c, journal[k][i])
			}
		}
		if route.AsString() == selectedRoute {
			K += point.Count
			E += slow
		} else {
			other += point.Count
		}
	}
	// The overflow must equal the journal of every attribute set the SDK did not retain.
	want := make([]uint64, len(routeBounds)+1)
	var truthRequests, truthSlow, truthAt int
	keys := make([]setKey, 0, len(journal))
	for k := range journal {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].route != keys[j].route {
			return keys[i].route < keys[j].route
		}
		return keys[i].method < keys[j].method
	})
	for _, k := range keys {
		counts := journal[k]
		t := setTally{Route: k.route, Method: k.method, Retained: retained[k], AtThreshold: atThreshold[k]}
		for i, c := range counts {
			t.Requests += c
			if i >= slowFrom {
				t.Slow += c
			} else {
				t.Fast += c
			}
			if !retained[k] {
				want[i] += uint64(c)
			}
		}
		if k.route == selectedRoute {
			truthRequests += t.Requests
			truthSlow += t.Slow
			truthAt += t.AtThreshold
		}
		ev.Sets = append(ev.Sets, t)
	}
	for i := range want {
		if want[i] != overflowBuckets[i] {
			return ev, nil, fmt.Errorf("overflow bucket %d: SDK %d, journal %d", i, overflowBuckets[i], want[i])
		}
	}
	if int(K+other+F+S) != ev.Observations {
		return ev, nil, fmt.Errorf("SDK conservation failed")
	}
	// Truth must lie in the attainable bounds; K = 0 admits no bounds at all.
	if K > 0 {
		lowN, lowD := int(E), int(K+F)
		upN, upD := int(E+S), int(K+S)
		if truthSlow*lowD < lowN*truthRequests || truthSlow*upD > upN*truthRequests {
			return ev, nil, fmt.Errorf("truth %d/%d outside [%d/%d, %d/%d]", truthSlow, truthRequests, lowN, lowD, upN, upD)
		}
	}
	switch name {
	case "route-overflow":
		if F == 0 || S == 0 || K == 0 || !retained[setKey{selectedRoute, "GET"}] || retained[setKey{selectedRoute, "POST"}] {
			return ev, nil, fmt.Errorf("the small limit did not produce the intended retained/overflow split")
		}
	case "route-no-overflow":
		if F != 0 || S != 0 || int(K) != truthRequests || int(E) != truthSlow {
			return ev, nil, fmt.Errorf("the large limit still overflowed")
		}
	case "route-absent":
		if K != 0 || F+S == 0 || truthRequests == 0 {
			return ev, nil, fmt.Errorf("the selected route was unexpectedly retained")
		}
	}
	if wantSelectedRetained && K == 0 {
		return ev, nil, fmt.Errorf("the selected route should have ordinary points")
	}
	ev.K, ev.E, ev.F, ev.S, ev.OtherRoutes = fmt.Sprint(K), fmt.Sprint(E), fmt.Sprint(F), fmt.Sprint(S), fmt.Sprint(other)
	ev.Truth = routeTruth{fmt.Sprint(truthRequests), fmt.Sprint(truthSlow), fmt.Sprint(truthAt)}
	payload, err := exportPayload(ctx, &rm)
	return ev, payload, err
}
