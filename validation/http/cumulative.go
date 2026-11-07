package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
)

// Cumulative window experiment: a real otelhttp server, the Go SDK's default
// cumulative temporality and a small explicit cardinality limit. The traffic
// before the first snapshot creates ordinary series and overflow; the window
// workload between the snapshots has an independent client-side tally.

const cumulativeLimit = 8

type phase struct {
	Plan             []step        `json:"plan"`
	Total            int           `json:"total"`
	ServerErrors     int           `json:"serverErrors"`
	ObservedStatuses []statusCount `json:"observedStatuses"`
}
type fileEvidence struct {
	Role               string   `json:"role"`
	File               string   `json:"file"`
	SHA256             string   `json:"sha256"`
	Bytes              int      `json:"bytes"`
	CollectionUnixNano string   `json:"timeUnixNano"`
	StartUnixNano      []string `json:"startTimeUnixNano"`
	Total              string   `json:"total"`
	OrdinaryPoints     int      `json:"ordinaryPoints"`
	OverflowPoints     int      `json:"overflowPoints"`
	OverflowCount      string   `json:"overflowCount"`
}
type sourceFile struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}
type windowResult struct {
	K                string `json:"K"`
	E                string `json:"E"`
	O                string `json:"O"`
	T                string `json:"T"`
	TruthTotal       string `json:"truthTotal"`
	TruthServerError string `json:"truthServerErrors"`
	BaselineTotal    string `json:"baselineTotal"`
	AfterTotal       string `json:"afterTotal"`
}
type cumulativeManifest struct {
	Go               string            `json:"go"`
	Commands         []string          `json:"commands"`
	Modules          map[string]string `json:"modules"`
	Semconv          string            `json:"semconv"`
	Metric           string            `json:"metric"`
	Temporality      string            `json:"temporality"`
	Aggregation      string            `json:"aggregation"`
	Views            string            `json:"views"`
	CardinalityLimit int               `json:"cardinalityLimit"`
	Boundaries       []float64         `json:"explicitBounds"`
	Serializer       string            `json:"serializer"`
	Instrumented     string            `json:"instrumentation"`
	Baseline         phase             `json:"baseline"`
	Window           phase             `json:"window"`
	Files            []fileEvidence    `json:"files"`
	Sources          []sourceFile      `json:"harnessSources"`
	Result           windowResult      `json:"result"`
	Restart          string            `json:"restart"`
}

func cumulativeBaseline() []step {
	plan := []step{
		{"alpha", "GET", 200, 120}, {"alpha", "GET", 404, 10}, {"alpha", "GET", 500, 6},
		{"alpha", "GET", 503, 3}, {"beta", "POST", 201, 15}, {"beta", "POST", 502, 2},
		{"beta", "GET", 200, 20},
	}
	for i := 0; i < 40; i++ {
		plan = append(plan, step{fmt.Sprintf("base-%03d", i), "GET", burstStatus(i), 1})
	}
	return plan
}

// The window reuses the seven retained attribute sets, adds known clients with
// statuses never seen before (new attribute sets overflow), and unique burst clients.
func cumulativeWindow() []step {
	plan := []step{
		{"alpha", "GET", 200, 300}, {"alpha", "GET", 404, 25}, {"alpha", "GET", 500, 9},
		{"alpha", "GET", 503, 7}, {"beta", "POST", 201, 45}, {"beta", "POST", 502, 5},
		{"beta", "GET", 200, 55}, {"alpha", "GET", 504, 3}, {"beta", "GET", 500, 2},
	}
	for i := 0; i < 100; i++ {
		plan = append(plan, step{fmt.Sprintf("win-%03d", i), "GET", burstStatus(i), 1})
	}
	return plan
}

func burstStatus(i int) int {
	switch {
	case i%7 == 0:
		return 500
	case i%11 == 0:
		return 503
	case i%5 == 0:
		return 404
	}
	return 200
}

// process is one SDK incarnation: a new provider starts new cumulative series.
type process struct {
	provider *sdk.MeterProvider
	reader   *sdk.ManualReader
	handler  http.Handler
}

type lab struct {
	ctx      context.Context
	mux      *http.ServeMux
	current  func() *process
	set      func(*process)
	server   *httptest.Server
	inflight sync.WaitGroup
	mu       sync.Mutex
	served   map[int]int
}

func newLab(ctx context.Context) *lab {
	l := &lab{ctx: ctx, mux: http.NewServeMux(), served: map[int]int{}}
	var mu sync.RWMutex
	var cur *process
	l.current = func() *process { mu.RLock(); defer mu.RUnlock(); return cur }
	l.set = func(p *process) { mu.Lock(); defer mu.Unlock(); cur = p }
	l.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		status, err := strconv.Atoi(r.URL.Query().Get("status"))
		if err != nil {
			status = 400
		}
		if labeler, ok := otelhttp.LabelerFromContext(r.Context()); ok {
			labeler.Add(attribute.String("test.client", r.Header.Get("X-Test-Client")))
		}
		l.mu.Lock()
		l.served[status]++
		l.mu.Unlock()
		w.WriteHeader(status)
		_, _ = io.WriteString(w, "ok")
	})
	// One server for every incarnation, so server.address and server.port are
	// stable. inflight covers the instrumentation's metric recording after the handler.
	l.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.inflight.Add(1)
		defer l.inflight.Done()
		l.current().handler.ServeHTTP(w, r)
	}))
	return l
}

func (l *lab) start() *process {
	reader := sdk.NewManualReader() // no temporality selector: the SDK default is cumulative
	provider := sdk.NewMeterProvider(
		sdk.WithReader(reader),
		sdk.WithCardinalityLimit(cumulativeLimit),
		sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", "overflowlens-http-cumulative-validation"))),
	)
	p := &process{provider: provider, reader: reader,
		handler: otelhttp.NewHandler(l.mux, "overflowlens-http-validation", otelhttp.WithMeterProvider(provider))}
	l.set(p)
	return p
}

// drive sends the plan sequentially and returns the client-side tally of completed
// responses; it must equal the server-side tally taken inside the handler.
func (l *lab) drive(plan []step) (phase, error) {
	l.mu.Lock()
	l.served = map[int]int{}
	l.mu.Unlock()
	client := &http.Client{}
	defer client.CloseIdleConnections()
	seen := map[int]int{}
	for _, s := range plan {
		for i := 0; i < s.Count; i++ {
			req, err := http.NewRequestWithContext(l.ctx, s.Method, l.server.URL+"/?status="+strconv.Itoa(s.Status), nil)
			if err != nil {
				return phase{}, err
			}
			req.Header.Set("X-Test-Client", s.Client)
			resp, err := client.Do(req)
			if err != nil {
				return phase{}, err
			}
			_, err = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if err != nil {
				return phase{}, err
			}
			seen[resp.StatusCode]++
		}
	}
	// Every handler, including its metric recording, has returned.
	l.inflight.Wait()
	out := phase{Plan: plan}
	for status, n := range seen {
		l.mu.Lock()
		served := l.served[status]
		l.mu.Unlock()
		if served != n {
			return out, fmt.Errorf("client and server tallies disagree for %d: %d vs %d", status, n, served)
		}
		out.Total += n
		if status >= 500 {
			out.ServerErrors += n
		}
		out.ObservedStatuses = append(out.ObservedStatuses, statusCount{status, n})
	}
	sort.Slice(out.ObservedStatuses, func(i, j int) bool { return out.ObservedStatuses[i].Status < out.ObservedStatuses[j].Status })
	return out, nil
}

func (l *lab) collect(p *process) (metricdata.ResourceMetrics, *metricdata.Histogram[float64], error) {
	var rm metricdata.ResourceMetrics
	if err := p.reader.Collect(l.ctx, &rm); err != nil {
		return rm, nil, err
	}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != metricName {
				continue
			}
			h, ok := m.Data.(metricdata.Histogram[float64])
			if !ok || h.Temporality != metricdata.CumulativeTemporality || m.Unit != "s" {
				return rm, nil, fmt.Errorf("default reader did not emit a cumulative %s histogram: %T unit=%q", metricName, m.Data, m.Unit)
			}
			return rm, &h, nil
		}
	}
	return rm, nil, fmt.Errorf("%s was not exported", metricName)
}

type seriesKey = attribute.Distinct

func index(h *metricdata.Histogram[float64]) map[seriesKey]metricdata.HistogramDataPoint[float64] {
	out := map[seriesKey]metricdata.HistogramDataPoint[float64]{}
	for _, p := range h.DataPoints {
		out[p.Attributes.Equivalent()] = p
	}
	return out
}

func describe(role, file string, payload []byte, h *metricdata.Histogram[float64]) fileEvidence {
	sum := sha256.Sum256(payload)
	ev := fileEvidence{Role: role, File: file, SHA256: hex.EncodeToString(sum[:]), Bytes: len(payload)}
	starts := map[string]bool{}
	var total, overflow uint64
	for _, p := range h.DataPoints {
		ev.CollectionUnixNano = fmt.Sprint(p.Time.UnixNano())
		starts[fmt.Sprint(p.StartTime.UnixNano())] = true
		total += p.Count
		if p.Attributes.HasValue(overflowAttr) {
			ev.OverflowPoints++
			overflow += p.Count
		} else {
			ev.OrdinaryPoints++
		}
	}
	for s := range starts {
		ev.StartUnixNano = append(ev.StartUnixNano, s)
	}
	sort.Strings(ev.StartUnixNano)
	ev.Total, ev.OverflowCount = fmt.Sprint(total), fmt.Sprint(overflow)
	return ev
}

const overflowAttr = "otel.metric.overflow"

func hashSource(path, label string) (sourceFile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return sourceFile{}, err
	}
	sum := sha256.Sum256(b)
	return sourceFile{File: label, SHA256: hex.EncodeToString(sum[:])}, nil
}

func runCumulative() error {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	out := filepath.Join("..", "fixtures", "http")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	l := newLab(ctx)
	defer l.server.Close()
	first := l.start()
	defer first.provider.Shutdown(context.Background())

	// 1. Traffic before the first snapshot: ordinary series and overflow. Export 1.
	baseline, err := l.drive(cumulativeBaseline())
	if err != nil {
		return err
	}
	rm1, h1, err := l.collect(first)
	if err != nil {
		return err
	}
	beforePayload, err := exportPayload(ctx, &rm1)
	if err != nil {
		return err
	}
	// 2. The deterministic window workload with an independent tally. Export 2.
	window, err := l.drive(cumulativeWindow())
	if err != nil {
		return err
	}
	rm2, h2, err := l.collect(first)
	if err != nil {
		return err
	}
	afterPayload, err := exportPayload(ctx, &rm2)
	if err != nil {
		return err
	}
	// A later collection without new requests: a real zero-increment window.
	rm3, h3, err := l.collect(first)
	if err != nil {
		return err
	}
	zeroPayload, err := exportPayload(ctx, &rm3)
	if err != nil {
		return err
	}

	// Independent differencing of the SDK structs (not of the exported JSON).
	bm, am, zm := index(h1), index(h2), index(h3)
	if len(bm) != len(am) || len(am) != len(zm) {
		return fmt.Errorf("the series set changed between collections: %d, %d, %d", len(bm), len(am), len(zm))
	}
	var K, E, O, baselineTotal, afterTotal uint64
	var bounds []float64
	for key, ap := range am {
		bp, ok := bm[key]
		if !ok || !bp.StartTime.Equal(ap.StartTime) || !bp.Time.Before(ap.Time) || ap.Count < bp.Count {
			return fmt.Errorf("unexpected cumulative continuity")
		}
		zp := zm[key]
		if zp.Count != ap.Count || !zp.StartTime.Equal(ap.StartTime) || !ap.Time.Before(zp.Time) {
			return fmt.Errorf("zero window was not zero")
		}
		bounds = ap.Bounds
		baselineTotal += bp.Count
		afterTotal += ap.Count
		n := ap.Count - bp.Count
		if v, ok := ap.Attributes.Value(overflowAttr); ok {
			if v.Type() != attribute.BOOL || !v.AsBool() || ap.Attributes.Len() != 1 {
				return fmt.Errorf("non-SDK overflow shape")
			}
			O += n
			continue
		}
		v, ok := ap.Attributes.Value("http.response.status_code")
		if !ok || v.Type() != attribute.INT64 {
			return fmt.Errorf("ordinary point without an integer status code")
		}
		K += n
		if v.AsInt64() >= 500 {
			E += n
		}
	}
	T := K + O
	if baselineTotal != uint64(baseline.Total) || afterTotal != uint64(baseline.Total+window.Total) {
		return fmt.Errorf("boundary counts %d/%d disagree with the tallies %d/%d", baselineTotal, afterTotal, baseline.Total, baseline.Total+window.Total)
	}
	if T != uint64(window.Total) {
		return fmt.Errorf("SDK conservation failed: window T=%d truth=%d", T, window.Total)
	}
	if E > uint64(window.ServerErrors) || uint64(window.ServerErrors) > E+O {
		return fmt.Errorf("truth %d outside [%d,%d]", window.ServerErrors, E, E+O)
	}
	for _, e := range []struct {
		name string
		h    *metricdata.Histogram[float64]
	}{{"before", h1}, {"after", h2}} {
		var overflow uint64
		for _, p := range e.h.DataPoints {
			if p.Attributes.HasValue(overflowAttr) {
				overflow += p.Count
			}
		}
		if overflow == 0 {
			return fmt.Errorf("no overflow at the %s snapshot", e.name)
		}
	}
	if O == 0 || E == 0 || E+O == uint64(window.ServerErrors) || E == uint64(window.ServerErrors) {
		return fmt.Errorf("the window does not exercise an uncertain interval: E=%d O=%d truth=%d", E, O, window.ServerErrors)
	}

	// 3. Restart: a new provider (new start times) that has served the baseline and
	// the window again, so every count is at least the first snapshot's. Counts alone
	// cannot reveal the restart.
	if err := first.provider.Shutdown(ctx); err != nil {
		return err
	}
	second := l.start()
	defer second.provider.Shutdown(context.Background())
	if _, err := l.drive(cumulativeBaseline()); err != nil {
		return err
	}
	if _, err := l.drive(cumulativeWindow()); err != nil {
		return err
	}
	rm4, h4, err := l.collect(second)
	if err != nil {
		return err
	}
	restartPayload, err := exportPayload(ctx, &rm4)
	if err != nil {
		return err
	}
	rm := index(h4)
	if len(rm) != len(bm) {
		return fmt.Errorf("the restarted series set differs: %d vs %d", len(rm), len(bm))
	}
	for key, rp := range rm {
		bp, ok := bm[key]
		if !ok || bp.StartTime.Equal(rp.StartTime) || rp.Count < bp.Count || !bp.Time.Before(rp.Time) {
			return fmt.Errorf("the restart must change every start, keep counts at or above the first snapshot and be later")
		}
	}

	manifest := cumulativeManifest{
		Go: runtime.Version(),
		Commands: []string{
			"npm run validate:http-cumulative",
			"cd validation && go run ./http cumulative",
			"vitest run tests/http-cumulative-sdk.test.ts",
		},
		Modules:          map[string]string{},
		Metric:           metricName,
		Temporality:      "SDK default: sdk.NewManualReader() without a temporality selector, so every instrument is cumulative",
		Aggregation:      "default aggregation for Histogram instruments: explicit bucket histogram using the instrumentation's advisory boundaries; min and max recorded",
		Views:            "none",
		CardinalityLimit: cumulativeLimit,
		Boundaries:       bounds,
		Serializer:       "OTLP HTTP exporter → OTLP protobuf → protojson (UseEnumNumbers)",
		Instrumented:     "net/http server wrapped by otelhttp.NewHandler; one loopback server for every SDK incarnation",
		Baseline:         baseline,
		Window:           window,
		Restart:          "A second MeterProvider (a restarted SDK) served the baseline and the window workload again on the same server: same series, counts at or above the first snapshot, new start times.",
		Result: windowResult{
			K: fmt.Sprint(K), E: fmt.Sprint(E), O: fmt.Sprint(O), T: fmt.Sprint(T),
			TruthTotal: fmt.Sprint(window.Total), TruthServerError: fmt.Sprint(window.ServerErrors),
			BaselineTotal: fmt.Sprint(baselineTotal), AfterTotal: fmt.Sprint(afterTotal),
		},
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			switch dep.Path {
			case "go.opentelemetry.io/otel", "go.opentelemetry.io/otel/sdk", "go.opentelemetry.io/otel/sdk/metric",
				"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp",
				"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp",
				"go.opentelemetry.io/proto/otlp", "google.golang.org/protobuf":
				manifest.Modules[dep.Path] = dep.Version
			}
		}
	}
	manifest.Semconv = "go.opentelemetry.io/otel/semconv/v1.43.0 (httpconv, used by otelhttp " +
		manifest.Modules["go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"] + ")"
	for _, f := range []struct {
		role, file string
		payload    []byte
		h          *metricdata.Histogram[float64]
	}{
		{"before", "http-cumulative-before.json", beforePayload, h1},
		{"after", "http-cumulative-after.json", afterPayload, h2},
		{"zero", "http-cumulative-zero.json", zeroPayload, h3},
		{"restart", "http-cumulative-restart.json", restartPayload, h4},
	} {
		if err := os.WriteFile(filepath.Join(out, f.file), f.payload, 0o644); err != nil {
			return err
		}
		manifest.Files = append(manifest.Files, describe(f.role, f.file, f.payload, f.h))
	}
	for _, s := range [][2]string{
		{"http/main.go", "validation/http/main.go"}, {"http/cumulative.go", "validation/http/cumulative.go"},
		{"go.mod", "validation/go.mod"}, {"go.sum", "validation/go.sum"},
	} {
		src, err := hashSource(s[0], s[1])
		if err != nil {
			return err
		}
		manifest.Sources = append(manifest.Sources, src)
	}
	b, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(out, "cumulative-manifest.json"), append(b, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("window: K=%d E=%d O=%d T=%d truth=%d/%d baseline=%d after=%d series=%d (limit %d)\n",
		K, E, O, T, window.ServerErrors, window.Total, baselineTotal, afterTotal, len(am), cumulativeLimit)
	return nil
}
