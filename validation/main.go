// Validate SDK request-counter exports against a controlled workload.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	api "go.opentelemetry.io/otel/metric"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	pb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
)

type observation struct {
	Success   bool   `json:"success"`
	RequestID string `json:"requestId"`
	Count     int64  `json:"count"`
}
type evidence struct {
	Name             string        `json:"name"`
	File             string        `json:"file"`
	View             bool          `json:"view"`
	ThresholdPercent string        `json:"thresholdPercent"`
	Expected         string        `json:"expected"`
	TruthTotal       string        `json:"truthTotal"`
	TruthErrors      string        `json:"truthErrors"`
	K                string        `json:"K"`
	E                string        `json:"E"`
	O                string        `json:"O"`
	T                string        `json:"T"`
	GroundTruth      []observation `json:"groundTruth"`
}
type manifest struct {
	SDK              string           `json:"sdk"`
	Serializer       string           `json:"serializer"`
	CardinalityLimit int              `json:"cardinalityLimit"`
	Cases            []evidence       `json:"cases"`
	CumulativeCases  []windowEvidence `json:"cumulativeCases"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	obs := []observation{{true, "known-success", 900}, {false, "known-error", 1}}
	for i := 0; i < 99; i++ {
		obs = append(obs, observation{i%3 != 0, fmt.Sprintf("unique-%03d", i), 1})
	}
	out := filepath.Join("..", "fixtures", "sdk")
	if err := os.MkdirAll(out, 0755); err != nil {
		return err
	}
	result := manifest{SDK: "go.opentelemetry.io/otel/sdk/metric v1.47.0", Serializer: "OTLP HTTP exporter v1.47.0 → OTLP protobuf v1.11.0 → protojson v1.36.12 (UseEnumNumbers)", CardinalityLimit: 3}
	for _, c := range []struct{ name, p, expected string }{{"within", "10", "WITHIN_LIMIT"}, {"exceeds", "0", "EXCEEDS_LIMIT"}, {"indeterminate", "1", "INDETERMINATE"}} {
		for _, view := range []bool{false, true} {
			ev, payload, err := experiment(c.name, c.p, c.expected, obs, view)
			if err != nil {
				return fmt.Errorf("%s view=%v: %w", c.name, view, err)
			}
			if err = os.WriteFile(filepath.Join(out, ev.File), payload, 0644); err != nil {
				return err
			}
			result.Cases = append(result.Cases, ev)
			fmt.Printf("%s: K=%s E=%s O=%s T=%s truth=%s/%s → %s\n", ev.File, ev.K, ev.E, ev.O, ev.T, ev.TruthErrors, ev.TruthTotal, ev.Expected)
		}
	}
	for _, view := range []bool{false, true} {
		ev, payloads, err := cumulativeExperiment(obs, view)
		if err != nil {
			return fmt.Errorf("cumulative view=%v: %w", view, err)
		}
		for file, payload := range payloads {
			if err := os.WriteFile(filepath.Join(out, file), payload, 0644); err != nil {
				return err
			}
		}
		result.CumulativeCases = append(result.CumulativeCases, ev)
		fmt.Printf("%s → %s: baseline=%s overflow=%s; window K=%s E=%s O=%s T=%s truth=%s/%s → %s; zero and restart exports captured\n", ev.BeforeFile, ev.AfterFile, ev.BaselineTotal, ev.BaselineOverflow, ev.K, ev.E, ev.O, ev.T, ev.TruthErrors, ev.TruthTotal, ev.Expected)
	}
	b, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "manifest.json"), append(b, '\n'), 0644)
}
func experiment(name, p, expected string, obs []observation, view bool) (evidence, []byte, error) {
	ctx := context.Background()
	ev := evidence{Name: name, View: view, ThresholdPercent: p, Expected: expected, GroundTruth: obs, File: name + ".json"}
	if view {
		ev.File = name + "-view.json"
	}
	reader := sdk.NewManualReader(sdk.WithTemporalitySelector(func(sdk.InstrumentKind) metricdata.Temporality { return metricdata.DeltaTemporality }))
	opts := []sdk.Option{sdk.WithReader(reader), sdk.WithCardinalityLimit(3), sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", "overflowlens-validation")))}
	if view {
		opts = append(opts, sdk.WithView(sdk.NewView(sdk.Instrument{Name: "http.server.requests", Kind: sdk.InstrumentKindCounter}, sdk.Stream{AttributeFilter: func(kv attribute.KeyValue) bool { return kv.Key == "success" }})))
	}
	provider := sdk.NewMeterProvider(opts...)
	defer provider.Shutdown(ctx)
	counter, err := provider.Meter("overflowlens.validation", api.WithInstrumentationVersion("0.1.0")).Int64Counter("http.server.requests", api.WithUnit("{request}"))
	if err != nil {
		return ev, nil, err
	}
	var baseline metricdata.ResourceMetrics
	// Explicit baseline and final collection. No periodic timer or sleep.
	if err = reader.Collect(ctx, &baseline); err != nil {
		return ev, nil, err
	}
	var truthTotal, truthErrors int64
	for _, o := range obs {
		truthTotal += o.Count
		if !o.Success {
			truthErrors += o.Count
		}
		counter.Add(ctx, o.Count, api.WithAttributes(attribute.Bool("success", o.Success), attribute.String("request.id", o.RequestID)))
	}
	var rm metricdata.ResourceMetrics
	if err = reader.Collect(ctx, &rm); err != nil {
		return ev, nil, err
	}
	if len(rm.ScopeMetrics) != 1 || len(rm.ScopeMetrics[0].Metrics) != 1 {
		return ev, nil, fmt.Errorf("expected one stream")
	}
	sum, ok := rm.ScopeMetrics[0].Metrics[0].Data.(metricdata.Sum[int64])
	if !ok || !sum.IsMonotonic || sum.Temporality != metricdata.DeltaTemporality {
		return ev, nil, fmt.Errorf("unexpected SDK data type")
	}
	var K, E, O int64
	for _, point := range sum.DataPoints {
		if v, ok := point.Attributes.Value("otel.metric.overflow"); ok {
			if v.Type() != attribute.BOOL || !v.AsBool() || point.Attributes.Len() != 1 {
				return ev, nil, fmt.Errorf("non-SDK overflow shape")
			}
			O += point.Value
		} else {
			v, ok := point.Attributes.Value("success")
			if !ok || v.Type() != attribute.BOOL {
				return ev, nil, fmt.Errorf("missing outcome")
			}
			K += point.Value
			if !v.AsBool() {
				E += point.Value
			}
		}
	}
	T := K + O
	if T != truthTotal || E > truthErrors || truthErrors > E+O {
		return ev, nil, fmt.Errorf("conservation or bounds failed")
	}
	if view && (O != 0 || E != truthErrors) {
		return ev, nil, fmt.Errorf("View did not make the result exact")
	}
	if !view && O <= 0 {
		return ev, nil, fmt.Errorf("no overflow")
	}
	threshold, ok := new(big.Rat).SetString(p)
	if !ok {
		return ev, nil, fmt.Errorf("bad threshold")
	}
	threshold.Quo(threshold, big.NewRat(100, 1))
	status := "INDETERMINATE"
	if big.NewRat(E+O, T).Cmp(threshold) <= 0 {
		status = "WITHIN_LIMIT"
	} else if big.NewRat(E, T).Cmp(threshold) > 0 {
		status = "EXCEEDS_LIMIT"
	}
	if view {
		ev.Expected = status
	} else if status != expected {
		return ev, nil, fmt.Errorf("expected %s, got %s", expected, status)
	}
	ev.K = fmt.Sprint(K)
	ev.E = fmt.Sprint(E)
	ev.O = fmt.Sprint(O)
	ev.T = fmt.Sprint(T)
	ev.TruthTotal = fmt.Sprint(truthTotal)
	ev.TruthErrors = fmt.Sprint(truthErrors)
	payload, err := exportPayload(ctx, &rm)
	return ev, payload, err
}

func exportPayload(ctx context.Context, rm *metricdata.ResourceMetrics) ([]byte, error) {
	// Capture the real official exporter protobuf, then serialize with official protojson.
	// The disposable loopback receiver preserves the exporter payload.
	payloads := make(chan []byte, 1)
	errors := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	defer server.Close()
	exporter, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(server.URL), otlpmetrichttp.WithInsecure(), otlpmetrichttp.WithCompression(otlpmetrichttp.NoCompression), otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}), otlpmetrichttp.WithHeaders(map[string]string{}))
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
