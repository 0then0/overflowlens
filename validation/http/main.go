// Validate the HTTP 5xx histogram mode against real OpenTelemetry Go HTTP
// instrumentation (otelhttp) serving a deterministic workload on loopback.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"sync"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	pb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const (
	metricName = "http.server.request.duration"
	scopeName  = "overflowlens.http.validation"
	overflow   = "otel.metric.overflow"
)

type step struct {
	Client string `json:"client"`
	Method string `json:"method"`
	Status int    `json:"status"`
	Count  int    `json:"count"`
}
type statusCount struct {
	Status int `json:"status"`
	Count  int `json:"count"`
}
type evidence struct {
	Name             string        `json:"name"`
	File             string        `json:"file"`
	CardinalityLimit int           `json:"cardinalityLimit"`
	K                string        `json:"K"`
	E                string        `json:"E"`
	O                string        `json:"O"`
	T                string        `json:"T"`
	OrdinaryPoints   int           `json:"ordinaryPoints"`
	OverflowPoints   int           `json:"overflowPoints"`
	TruthTotal       string        `json:"truthTotal"`
	TruthServerError string        `json:"truthServerErrors"`
	ObservedStatuses []statusCount `json:"observedStatuses"`
}
type manifest struct {
	Go           string            `json:"go"`
	Modules      map[string]string `json:"modules"`
	Semconv      string            `json:"semconv"`
	Metric       string            `json:"metric"`
	Temporality  string            `json:"temporality"`
	Aggregation  string            `json:"aggregation"`
	Boundaries   []float64         `json:"explicitBounds"`
	Views        string            `json:"views"`
	Workload     []step            `json:"workload"`
	Serializer   string            `json:"serializer"`
	Cases        []evidence        `json:"cases"`
	Instrumented string            `json:"instrumentation"`
}

// `go run ./http` regenerates the delta fixtures; `go run ./http cumulative`
// regenerates the cumulative window fixtures (cumulative.go).
func main() {
	var err error
	switch {
	case len(os.Args) == 1:
		err = run()
	case len(os.Args) == 2 && os.Args[1] == "cumulative":
		err = runCumulative()
	default:
		err = fmt.Errorf("usage: go run ./http [cumulative]")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// workload is fixed, ordered and explicit. The first seven attribute sets are
// retained under a small limit; every burst client is a new attribute set.
func workload() []step {
	plan := []step{
		{"alpha", "GET", 200, 400}, {"alpha", "GET", 404, 30}, {"alpha", "GET", 500, 12},
		{"alpha", "GET", 503, 8}, {"beta", "POST", 201, 50}, {"beta", "POST", 502, 4},
		{"beta", "GET", 200, 60},
	}
	for i := 0; i < 120; i++ {
		status := 200
		switch {
		case i%7 == 0:
			status = 500
		case i%11 == 0:
			status = 503
		case i%5 == 0:
			status = 404
		}
		plan = append(plan, step{fmt.Sprintf("burst-%03d", i), "GET", status, 1})
	}
	return plan
}

func run() error {
	out := filepath.Join("..", "fixtures", "http")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	plan := workload()
	result := manifest{
		Go:           runtime.Version(),
		Metric:       metricName,
		Temporality:  "delta for every instrument kind (sdk.WithTemporalitySelector)",
		Aggregation:  "default aggregation for Histogram instruments: explicit bucket histogram using the instrumentation's advisory boundaries; min and max recorded",
		Views:        "none",
		Workload:     plan,
		Serializer:   "OTLP HTTP exporter → OTLP protobuf → protojson (UseEnumNumbers)",
		Instrumented: "net/http server wrapped by otelhttp.NewHandler",
		Modules:      map[string]string{},
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			switch dep.Path {
			case "go.opentelemetry.io/otel", "go.opentelemetry.io/otel/sdk", "go.opentelemetry.io/otel/sdk/metric",
				"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp",
				"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp",
				"go.opentelemetry.io/proto/otlp", "google.golang.org/protobuf":
				result.Modules[dep.Path] = dep.Version
			}
		}
	}
	result.Semconv = "go.opentelemetry.io/otel/semconv/v1.43.0 (httpconv, used by otelhttp " +
		result.Modules["go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"] + ")"
	for _, c := range []struct {
		name  string
		limit int
	}{{"http-overflow", 8}, {"http-no-overflow", 2000}} {
		ev, payload, bounds, err := experiment(c.name, c.limit, plan)
		if err != nil {
			return fmt.Errorf("%s: %w", c.name, err)
		}
		if err = os.WriteFile(filepath.Join(out, ev.File), payload, 0o644); err != nil {
			return err
		}
		result.Boundaries = bounds
		result.Cases = append(result.Cases, ev)
		fmt.Printf("%s: limit=%d K=%s E=%s O=%s T=%s truth=%s/%s ordinary=%d overflow=%d\n", ev.File, ev.CardinalityLimit,
			ev.K, ev.E, ev.O, ev.T, ev.TruthServerError, ev.TruthTotal, ev.OrdinaryPoints, ev.OverflowPoints)
	}
	b, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "manifest.json"), append(b, '\n'), 0o644)
}

func experiment(name string, limit int, plan []step) (evidence, []byte, []float64, error) {
	ctx := context.Background()
	ev := evidence{Name: name, File: name + ".json", CardinalityLimit: limit}
	reader := sdk.NewManualReader(sdk.WithTemporalitySelector(func(sdk.InstrumentKind) metricdata.Temporality {
		return metricdata.DeltaTemporality
	}))
	provider := sdk.NewMeterProvider(
		sdk.WithReader(reader),
		sdk.WithCardinalityLimit(limit),
		sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", "overflowlens-http-validation"))),
	)
	defer provider.Shutdown(ctx)

	// Server-side tally, taken before the instrumentation sees the response.
	var mu sync.Mutex
	serverSide := map[int]int{}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		status, err := strconv.Atoi(r.URL.Query().Get("status"))
		if err != nil {
			status = 400
		}
		if labeler, ok := otelhttp.LabelerFromContext(r.Context()); ok {
			labeler.Add(attribute.String("test.client", r.Header.Get("X-Test-Client")))
		}
		mu.Lock()
		serverSide[status]++
		mu.Unlock()
		w.WriteHeader(status)
		_, _ = io.WriteString(w, "ok")
	})
	server := httptest.NewServer(otelhttp.NewHandler(mux, "overflowlens-http-validation", otelhttp.WithMeterProvider(provider)))
	defer server.Close()

	var baseline metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &baseline); err != nil {
		return ev, nil, nil, err
	}
	// Independent client-side tally of completed responses.
	clientSide := map[int]int{}
	client := &http.Client{}
	for _, s := range plan {
		for i := 0; i < s.Count; i++ {
			req, err := http.NewRequestWithContext(ctx, s.Method, server.URL+"/?status="+strconv.Itoa(s.Status), nil)
			if err != nil {
				return ev, nil, nil, err
			}
			req.Header.Set("X-Test-Client", s.Client)
			resp, err := client.Do(req)
			if err != nil {
				return ev, nil, nil, err
			}
			if _, err = io.Copy(io.Discard, resp.Body); err != nil {
				return ev, nil, nil, err
			}
			resp.Body.Close()
			clientSide[resp.StatusCode]++
		}
	}
	client.CloseIdleConnections()
	// Close waits for every handler, including the instrumentation's metric recording.
	server.Close()

	var truthTotal, truthErrors int
	for status, n := range clientSide {
		truthTotal += n
		if status >= 500 {
			truthErrors += n
		}
		if serverSide[status] != n {
			return ev, nil, nil, fmt.Errorf("client and server tallies disagree for %d: %d vs %d", status, n, serverSide[status])
		}
		ev.ObservedStatuses = append(ev.ObservedStatuses, statusCount{status, n})
	}
	sortStatuses(ev.ObservedStatuses)

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &rm); err != nil {
		return ev, nil, nil, err
	}
	var hist *metricdata.Histogram[float64]
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != metricName {
				continue
			}
			h, ok := m.Data.(metricdata.Histogram[float64])
			if !ok || h.Temporality != metricdata.DeltaTemporality || m.Unit != "s" {
				return ev, nil, nil, fmt.Errorf("unexpected %s definition: %T unit=%q", metricName, m.Data, m.Unit)
			}
			hist = &h
		}
	}
	if hist == nil {
		return ev, nil, nil, fmt.Errorf("%s was not exported", metricName)
	}
	var K, E, O uint64
	var bounds []float64
	for _, point := range hist.DataPoints {
		bounds = point.Bounds
		if v, ok := point.Attributes.Value(overflow); ok {
			if v.Type() != attribute.BOOL || !v.AsBool() || point.Attributes.Len() != 1 {
				return ev, nil, nil, fmt.Errorf("non-SDK overflow shape")
			}
			O += point.Count
			ev.OverflowPoints++
			continue
		}
		v, ok := point.Attributes.Value("http.response.status_code")
		if !ok || v.Type() != attribute.INT64 {
			return ev, nil, nil, fmt.Errorf("ordinary point without an integer status code")
		}
		K += point.Count
		ev.OrdinaryPoints++
		if v.AsInt64() >= 500 {
			E += point.Count
		}
	}
	T := K + O
	if int(T) != truthTotal {
		return ev, nil, nil, fmt.Errorf("SDK conservation failed: T=%d truth=%d", T, truthTotal)
	}
	if int(E) > truthErrors || truthErrors > int(E+O) {
		return ev, nil, nil, fmt.Errorf("truth %d outside [%d,%d]", truthErrors, E, E+O)
	}
	if name == "http-overflow" && O == 0 {
		return ev, nil, nil, fmt.Errorf("the small cardinality limit produced no overflow")
	}
	if name == "http-no-overflow" && (O != 0 || int(E) != truthErrors) {
		return ev, nil, nil, fmt.Errorf("the large limit still overflowed")
	}
	ev.K, ev.E, ev.O, ev.T = fmt.Sprint(K), fmt.Sprint(E), fmt.Sprint(O), fmt.Sprint(T)
	ev.TruthTotal, ev.TruthServerError = fmt.Sprint(truthTotal), fmt.Sprint(truthErrors)
	payload, err := exportPayload(ctx, &rm)
	return ev, payload, bounds, err
}

func sortStatuses(s []statusCount) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j].Status < s[j-1].Status; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func exportPayload(ctx context.Context, rm *metricdata.ResourceMetrics) ([]byte, error) {
	// Capture the official exporter's protobuf, then serialize it with protojson.
	payloads := make(chan []byte, 1)
	errors := make(chan error, 1)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, e := io.ReadAll(r.Body)
		msg := new(pb.ExportMetricsServiceRequest)
		if e == nil {
			e = proto.Unmarshal(b, msg)
		}
		var payload []byte
		if e == nil {
			payload, e = (protojson.MarshalOptions{UseEnumNumbers: true, Indent: "  "}).Marshal(msg)
		}
		if e != nil {
			errors <- e
			w.WriteHeader(500)
			return
		}
		payloads <- append(payload, '\n')
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(200)
	}))
	defer receiver.Close()
	exporter, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(receiver.URL), otlpmetrichttp.WithInsecure(),
		otlpmetrichttp.WithCompression(otlpmetrichttp.NoCompression),
		otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}),
		otlpmetrichttp.WithHeaders(map[string]string{}))
	if err != nil {
		return nil, err
	}
	defer exporter.Shutdown(ctx)
	if err = exporter.Export(ctx, rm); err != nil {
		return nil, err
	}
	select {
	case b := <-payloads:
		return b, nil
	case e := <-errors:
		return nil, e
	default:
		return nil, fmt.Errorf("no export captured")
	}
}
