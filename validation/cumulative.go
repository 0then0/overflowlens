package main

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel/attribute"
	api "go.opentelemetry.io/otel/metric"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
)

type windowEvidence struct {
	evidence
	BeforeFile          string        `json:"beforeFile"`
	AfterFile           string        `json:"afterFile"`
	ZeroFile            string        `json:"zeroFile"`
	RestartFile         string        `json:"restartFile"`
	BaselineTotal       string        `json:"baselineTotal"`
	BaselineOverflow    string        `json:"baselineOverflow"`
	BaselineGroundTruth []observation `json:"baselineGroundTruth"`
}

func cumulativeExperiment(workload []observation, view bool) (windowEvidence, map[string][]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	prefix := "cumulative"
	if view {
		prefix += "-view"
	}
	baseline := []observation{{true, "known-success", 100}, {false, "known-error", 7}, {true, "baseline-overflow", 5}}
	ev := windowEvidence{evidence: evidence{Name: prefix, View: view, GroundTruth: workload, ThresholdPercent: "1"},
		BeforeFile: prefix + "-before.json", AfterFile: prefix + "-after.json", ZeroFile: prefix + "-zero.json", RestartFile: prefix + "-restart.json", BaselineGroundTruth: baseline}
	payloads := map[string][]byte{}
	create := func() (*sdk.MeterProvider, *sdk.ManualReader, api.Int64Counter, error) {
		// No temporality override: exercise the official reader's cumulative default.
		reader := sdk.NewManualReader()
		opts := []sdk.Option{sdk.WithReader(reader), sdk.WithCardinalityLimit(3), sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", "overflowlens-validation")))}
		if view {
			opts = append(opts, sdk.WithView(sdk.NewView(sdk.Instrument{Name: "http.server.requests", Kind: sdk.InstrumentKindCounter}, sdk.Stream{AttributeFilter: func(kv attribute.KeyValue) bool { return kv.Key == "success" }})))
		}
		provider := sdk.NewMeterProvider(opts...)
		counter, err := provider.Meter("overflowlens.validation", api.WithInstrumentationVersion("0.2.0")).Int64Counter("http.server.requests", api.WithUnit("{request}"))
		return provider, reader, counter, err
	}
	record := func(counter api.Int64Counter, observations []observation) {
		for _, o := range observations {
			counter.Add(ctx, o.Count, api.WithAttributes(attribute.Bool("success", o.Success), attribute.String("request.id", o.RequestID)))
		}
	}
	collect := func(reader *sdk.ManualReader, file string) (metricdata.Sum[int64], error) {
		var rm metricdata.ResourceMetrics
		if err := reader.Collect(ctx, &rm); err != nil {
			return metricdata.Sum[int64]{}, err
		}
		if len(rm.ScopeMetrics) != 1 || len(rm.ScopeMetrics[0].Metrics) != 1 {
			return metricdata.Sum[int64]{}, fmt.Errorf("expected one stream")
		}
		sum, ok := rm.ScopeMetrics[0].Metrics[0].Data.(metricdata.Sum[int64])
		if !ok || !sum.IsMonotonic || sum.Temporality != metricdata.CumulativeTemporality {
			return sum, fmt.Errorf("default reader did not emit monotonic cumulative Sum")
		}
		payload, err := exportPayload(ctx, &rm)
		if err == nil {
			payloads[file] = payload
		}
		return sum, err
	}
	provider, reader, counter, err := create()
	if err != nil {
		provider.Shutdown(context.Background())
		return ev, nil, err
	}
	defer provider.Shutdown(context.Background())
	record(counter, baseline)
	before, err := collect(reader, ev.BeforeFile)
	if err != nil {
		return ev, nil, err
	}
	record(counter, workload)
	after, err := collect(reader, ev.AfterFile)
	if err != nil {
		return ev, nil, err
	}
	zero, err := collect(reader, ev.ZeroFile)
	if err != nil {
		return ev, nil, err
	}
	key := func(p metricdata.DataPoint[int64]) attribute.Distinct { return p.Attributes.Equivalent() }
	bm := map[attribute.Distinct]metricdata.DataPoint[int64]{}
	am := map[attribute.Distinct]metricdata.DataPoint[int64]{}
	var baselineTotal, baselineOverflow, K, E, O int64
	for _, p := range before.DataPoints {
		bm[key(p)] = p
		baselineTotal += p.Value
		if p.Attributes.HasValue("otel.metric.overflow") {
			baselineOverflow += p.Value
		}
	}
	for _, p := range after.DataPoints {
		bp, exists := bm[key(p)]
		if !exists || !bp.StartTime.Equal(p.StartTime) || !bp.Time.Before(p.Time) || p.Value < bp.Value {
			return ev, nil, fmt.Errorf("unexpected cumulative continuity")
		}
		am[key(p)] = p
		n := p.Value - bp.Value
		if marker, ok := p.Attributes.Value("otel.metric.overflow"); ok {
			if marker.Type() != attribute.BOOL || !marker.AsBool() || p.Attributes.Len() != 1 {
				return ev, nil, fmt.Errorf("ambiguous overflow")
			}
			O += n
		} else {
			outcome, ok := p.Attributes.Value("success")
			if !ok || outcome.Type() != attribute.BOOL {
				return ev, nil, fmt.Errorf("missing outcome")
			}
			K += n
			if !outcome.AsBool() {
				E += n
			}
		}
	}
	if len(am) != len(bm) || len(zero.DataPoints) != len(am) {
		return ev, nil, fmt.Errorf("changed identity set")
	}
	for _, p := range zero.DataPoints {
		ap, exists := am[key(p)]
		if !exists || p.Value != ap.Value || !p.StartTime.Equal(ap.StartTime) || !ap.Time.Before(p.Time) {
			return ev, nil, fmt.Errorf("zero window was not zero")
		}
	}
	var total, errors int64
	for _, o := range workload {
		total += o.Count
		if !o.Success {
			errors += o.Count
		}
	}
	if baselineTotal != 112 || K+O != total || E > errors || errors > E+O {
		return ev, nil, fmt.Errorf("baseline, conservation or containment failed")
	}
	if !view && (baselineOverflow <= 0 || O <= 0) {
		return ev, nil, fmt.Errorf("overflow not present at both boundaries")
	}
	if view && (O != 0 || E != errors) {
		return ev, nil, fmt.Errorf("View not exact")
	}
	ev.K, ev.E, ev.O, ev.T = fmt.Sprint(K), fmt.Sprint(E), fmt.Sprint(O), fmt.Sprint(K+O)
	ev.TruthTotal, ev.TruthErrors = fmt.Sprint(total), fmt.Sprint(errors)
	ev.BaselineTotal, ev.BaselineOverflow = fmt.Sprint(baselineTotal), fmt.Sprint(baselineOverflow)
	ev.Expected = "INDETERMINATE"
	if view {
		ev.Expected = "EXCEEDS_LIMIT"
	}
	// Collect from a fresh provider to validate reset detection.
	restarted, restartReader, restartCounter, err := create()
	if err != nil {
		restarted.Shutdown(context.Background())
		return ev, nil, err
	}
	defer restarted.Shutdown(context.Background())
	record(restartCounter, baseline)
	restart, err := collect(restartReader, ev.RestartFile)
	if err != nil {
		return ev, nil, err
	}
	for _, p := range restart.DataPoints {
		bp, exists := bm[key(p)]
		if !exists || bp.StartTime.Equal(p.StartTime) {
			return ev, nil, fmt.Errorf("restart did not change start time")
		}
	}
	return ev, payloads, nil
}
