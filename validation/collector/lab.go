package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	api "go.opentelemetry.io/otel/metric"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	collectorpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// scenario is one Collector configuration driven with the same history. Accept is the primary
// scrape negotiation; the probe scrape uses the other. Only SaveOTLP scenarios keep OTLP artifacts.
type scenario struct {
	Name, Config, Accept, Probe string
	Drop, SaveOTLP              bool
}

func config(name string) string { return filepath.Join("collector", "configs", name+".yaml") }

var scenarios = []scenario{
	{"positive", config("positive"), classicAccept, openAccept, false, true},
	{"positive-openmetrics", config("positive-openmetrics"), openAccept, classicAccept, false, false},
	{"drop-overflow", config("drop-overflow"), classicAccept, openAccept, true, true},
}

type phase struct {
	name     string
	sdk, out stream
	raw      []byte
	removed  map[string]point
}

// runScenario sends one controlled history through a fresh Collector container. Every step waits
// for an observable acknowledgement (SDK export result, sink arrival) under a deadline.
func runScenario(ctx context.Context, spec scenario) (map[string]any, map[string][]byte, error) {
	sink, err := newSink()
	if err != nil {
		return nil, nil, err
	}
	defer sink.close()
	col, err := startCollector(ctx, spec.Config, sink.port())
	if err != nil {
		return nil, nil, err
	}
	defer col.stop()
	if err = col.waitReady(ctx); err != nil {
		return nil, nil, err
	}
	reader := sdk.NewManualReader() // default reader: cumulative temporality
	provider := sdk.NewMeterProvider(sdk.WithReader(reader), sdk.WithCardinalityLimit(3),
		sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", "overflowlens-validation"), attribute.String("deployment.environment.name", "collector-lab"), attribute.String("service.instance.id", "lab-instance-1"))))
	defer provider.Shutdown(context.Background())
	counter, err := provider.Meter("overflowlens.validation", api.WithInstrumentationVersion("0.2.0")).Int64Counter("http.server.requests", api.WithUnit("{request}"))
	if err != nil {
		return nil, nil, err
	}
	exporter, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL("http://"+col.otlpAddr+"/v1/metrics"), otlpmetrichttp.WithInsecure(),
		otlpmetrichttp.WithCompression(otlpmetrichttp.NoCompression), otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}), otlpmetrichttp.WithTimeout(10*time.Second))
	if err != nil {
		return nil, nil, err
	}
	defer exporter.Shutdown(context.Background())

	record := func(obs []observation) {
		for _, o := range obs {
			counter.Add(ctx, o.Count, api.WithAttributes(attribute.Bool("success", o.Success), attribute.String("request.id", o.RequestID)))
		}
	}
	collect := func() (*metricdata.ResourceMetrics, error) {
		rm := new(metricdata.ResourceMetrics)
		return rm, reader.Collect(ctx, rm)
	}
	files := map[string][]byte{}
	prom := map[string]any{}
	var phases []phase
	// export sends rm, waits for the sink to acknowledge the n-th export and checks what arrived.
	export := func(name string, rm *metricdata.ResourceMetrics) (phase, error) {
		p := phase{name: name}
		ectx, cancel := context.WithTimeout(ctx, stepTimeout)
		defer cancel()
		if err := exporter.Export(ectx, rm); err != nil {
			return p, fmt.Errorf("export %s: %w\ncollector log:\n%s", name, err, col.logs())
		}
		var err error
		if p.raw, err = sink.waitFor(ectx, len(phases)+1); err != nil {
			return p, fmt.Errorf("%s: %w\ncollector log:\n%s", name, err, col.logs())
		}
		if p.sdk, err = fromSDK(rm); err != nil {
			return p, err
		}
		if p.out, err = fromProtobuf(p.raw); err != nil {
			return p, err
		}
		if p.removed, err = preserved(p.sdk, p.out, spec.Drop); err != nil {
			return p, fmt.Errorf("%s: %w", name, err)
		}
		phases = append(phases, p)
		return p, nil
	}
	// look scrapes the Prometheus exporter at an acknowledged boundary and cross-checks the family.
	look := func(label string, p phase, accept string, repeat bool) (promEvidence, error) {
		first, err := doScrape(ctx, col.promAddr, accept)
		if err != nil {
			return promEvidence{}, err
		}
		ev, err := checkProm(first, p.out)
		if err != nil {
			return ev, fmt.Errorf("scrape %s: %w", label, err)
		}
		files[spec.Name+"-prometheus-"+label+".prom"] = first.Body
		if repeat {
			again, err := doScrape(ctx, col.promAddr, accept)
			if err != nil {
				return ev, err
			}
			ev2, err := checkProm(again, p.out)
			if err != nil || !reflect.DeepEqual(ev, ev2) {
				return ev, fmt.Errorf("scrape %s: a repeated scrape changed the exposition (%v)", label, err)
			}
			if label == "after" {
				files[spec.Name+"-prometheus-after-repeat.prom"] = again.Body
			}
		}
		return ev, nil
	}

	record(baseline())
	rm0, err := collect()
	if err != nil {
		return nil, nil, err
	}
	before, err := export("before", rm0)
	if err != nil {
		return nil, nil, err
	}
	if prom["before"], err = look("before", before, spec.Accept, true); err != nil {
		return nil, nil, err
	}
	obs := workload()
	record(obs)
	rm1, err := collect()
	if err != nil {
		return nil, nil, err
	}
	after, err := export("after", rm1)
	if err != nil {
		return nil, nil, err
	}
	if prom["after"], err = look("after", after, spec.Accept, true); err != nil {
		return nil, nil, err
	}
	probe, err := doScrape(ctx, col.promAddr, spec.Probe)
	if err != nil {
		return nil, nil, err
	}
	probeEv, err := checkProm(probe, after.out)
	if err != nil {
		return nil, nil, fmt.Errorf("negotiation probe: %w", err)
	}
	files[spec.Name+"-prometheus-after-probe.prom"] = probe.Body
	prom["negotiationProbe"] = map[string]any{"accept": spec.Probe, "contentType": probe.ContentType, "classicContentType": prom["after"].(promEvidence).ContentType, "samplesEqualClassic": reflect.DeepEqual(samplesOnly(probeEv), samplesOnly(prom["after"].(promEvidence)))}
	// A collection with no new observations, then an exact re-delivery of the After snapshot.
	rm2, err := collect()
	if err != nil {
		return nil, nil, err
	}
	zero, err := export("zero", rm2)
	if err != nil {
		return nil, nil, err
	}
	if prom["zero"], err = look("zero", zero, spec.Accept, false); err != nil {
		return nil, nil, err
	}
	reexport, err := export("after-reexport", rm1)
	if err != nil {
		return nil, nil, err
	}
	if prom["afterReexport"], err = look("after-reexport", reexport, spec.Accept, false); err != nil {
		return nil, nil, err
	}
	if n := sink.count(); n != 4 {
		return nil, nil, fmt.Errorf("sink acknowledged %d exports, expected 4", n)
	}

	// Independent ground truth and conservation.
	truthTotal, truthErrors := truth(obs)
	baseTotal, _ := truth(baseline())
	sdkWindow, err := window(before.sdk, after.sdk)
	if err != nil {
		return nil, nil, err
	}
	outWindow, err := window(before.out, after.out)
	if err != nil {
		return nil, nil, err
	}
	zeroWindow, err := window(after.out, zero.out)
	if err != nil || zeroWindow != (counts{}) {
		return nil, nil, fmt.Errorf("zero window is %+v (%v)", zeroWindow, err)
	}
	if !reflect.DeepEqual(reexport.out, after.out) {
		return nil, nil, fmt.Errorf("re-delivered After snapshot differs from the original")
	}
	if sdkWindow.T != truthTotal || sdkWindow.E > truthErrors || truthErrors > sdkWindow.E+sdkWindow.O || sdkWindow.O <= 0 {
		return nil, nil, fmt.Errorf("SDK window %+v violates conservation against truth %d/%d", sdkWindow, truthErrors, truthTotal)
	}
	if total, overflow := cumulativeTotal(before.sdk); total != baseTotal || overflow <= 0 {
		return nil, nil, fmt.Errorf("baseline total %d overflow %d", total, overflow)
	}
	var lost int64
	for _, p := range after.removed {
		lost += p.Value
	}
	var lostBefore int64
	for _, p := range before.removed {
		lostBefore += p.Value
	}
	afterTotal, _ := cumulativeTotal(after.sdk)
	// Prometheus totals must agree with OTLP and with the workload, not accumulate across scrapes.
	for _, c := range []struct {
		label string
		total int64
		want  int64
	}{{"before", prom["before"].(promEvidence).Total, baseTotal - lostBefore}, {"after", prom["after"].(promEvidence).Total, afterTotal - lost},
		{"zero", prom["zero"].(promEvidence).Total, afterTotal - lost}, {"afterReexport", prom["afterReexport"].(promEvidence).Total, afterTotal - lost}} {
		if c.total != c.want {
			return nil, nil, fmt.Errorf("Prometheus %s total %d, expected %d", c.label, c.total, c.want)
		}
	}
	if afterTotal != baseTotal+truthTotal {
		return nil, nil, fmt.Errorf("cumulative After total %d is not baseline %d + workload %d", afterTotal, baseTotal, truthTotal)
	}
	result := map[string]any{
		"identity": map[string]any{"resource": after.out.Resource, "scope": after.out.ScopeName + " " + after.out.ScopeVersion, "metric": after.out.Name, "unit": after.out.Unit,
			"temporality": "CUMULATIVE", "monotonic": true},
		"timestamps": map[string]any{"collectorPreservedSdkStartAndCollectionTimes": true, "startUnchangedAcrossExports": allSameStart(before.out, after.out, zero.out),
			"collectionTimesStrictlyIncrease": before.out.Points != nil && collectionTime(before.out) < collectionTime(after.out) && collectionTime(after.out) < collectionTime(zero.out)},
		"exports":             []any{exportView(before), exportView(after), exportView(zero), exportView(reexport)},
		"reexportEqualsAfter": true,
		"sdkWindow":           sdkWindow, "window": outWindow, "zeroWindow": zeroWindow,
		"truthContained": outWindow.E <= truthErrors && truthErrors <= outWindow.E+outWindow.O,
		"prometheus":     prom,
	}
	if spec.Drop {
		var removed []any
		for _, p := range phases[:3] {
			var keys []string
			for k := range p.removed {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				removed = append(removed, map[string]any{"phase": p.name, "attributes": k, "value": p.removed[k].Value})
			}
		}
		result["removedPoints"] = removed
		result["lostWindowOverflow"] = sdkWindow.O
		result["onlyOverflowRemoved"] = true
	}
	for _, p := range []phase{before, after, zero} {
		if !spec.SaveOTLP {
			break
		}
		files[spec.Name+"-"+p.name+".pb"] = p.raw
		msg := new(collectorpb.ExportMetricsServiceRequest)
		if err := proto.Unmarshal(p.raw, msg); err != nil {
			return nil, nil, err
		}
		js, err := (protojson.MarshalOptions{UseEnumNumbers: true, Indent: "  "}).Marshal(msg)
		if err != nil {
			return nil, nil, err
		}
		files[spec.Name+"-"+p.name+".json"] = append(js, '\n')
	}
	return result, files, nil
}

func samplesOnly(e promEvidence) []promSample { return e.Samples }

func collectionTime(s stream) uint64 {
	for _, p := range s.Points {
		return p.Time
	}
	return 0
}

func allSameStart(streams ...stream) bool {
	starts := map[string]uint64{}
	for i, s := range streams {
		for k, p := range s.Points {
			if prev, ok := starts[k]; ok && i > 0 && prev != p.Start {
				return false
			}
			starts[k] = p.Start
		}
	}
	return true
}

func exportView(p phase) map[string]any {
	var points []map[string]any
	for k, v := range p.out.Points {
		points = append(points, map[string]any{"attributes": k, "value": v.Value, "overflow": v.Overflow})
	}
	sort.Slice(points, func(i, j int) bool { return points[i]["attributes"].(string) < points[j]["attributes"].(string) })
	return map[string]any{"phase": p.name, "points": points}
}

func sha(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

func runLab(ctx context.Context, out string, replace bool, compare string) error {
	info, err := inspectImage(ctx)
	if err != nil {
		return err
	}
	prov, err := provenance(ctx, info)
	if err != nil {
		return err
	}
	tmp, err := os.MkdirTemp("", "overflowlens-collector-lab-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	semantic := map[string]any{}
	configs := map[string]string{}
	artifacts := map[string]string{}
	names := []string{}
	for _, spec := range scenarios {
		cfg, err := os.ReadFile(spec.Config)
		if err != nil {
			return err
		}
		configs[spec.Name] = sha(cfg)
		fmt.Printf("scenario %s: starting collector from %s\n", spec.Name, spec.Config)
		result, files, err := runScenario(ctx, spec)
		if err != nil {
			return fmt.Errorf("%s: %w", spec.Name, err)
		}
		semantic[spec.Name] = result
		for name, body := range files {
			if err := os.WriteFile(filepath.Join(tmp, name), body, 0o644); err != nil {
				return err
			}
			artifacts[name] = sha(body)
			names = append(names, name)
		}
		w := result["window"].(counts)
		fmt.Printf("scenario %s: window K=%d E=%d O=%d T=%d; truth contained=%v\n", spec.Name, w.K, w.E, w.O, w.T, result["truthContained"])
	}
	truthTotal, truthErrors := truth(workload())
	baseTotal, _ := truth(baseline())
	manifest := map[string]any{
		"schema": 1,
		"pinned": map[string]any{"image": imageRef, "version": imageVersion, "configSha256": configs,
			"workloadSeed": "known-success 900, known-error 1, unique-000..098 (33 errors); baseline 100/7/5 before the first snapshot; SDK cardinality limit 3"},
		"groundTruth": map[string]any{"observations": workload(), "baselineObservations": baseline(), "truthTotal": truthTotal, "truthErrors": truthErrors, "baselineTotal": baseTotal},
		"semantic":    semantic,
		"provenance":  map[string]any{"environment": prov, "generatedAt": time.Now().UTC().Format(time.RFC3339), "artifactSha256": artifacts},
	}
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	names = append(names, "manifest.json")
	if err := os.WriteFile(filepath.Join(tmp, "manifest.json"), body, 0o644); err != nil {
		return err
	}
	if out != "" {
		return publish(tmp, out, replace, names)
	}
	return compareSemantic(body, compare)
}

// publish copies a completed run into out. Existing evidence is never replaced without --replace.
func publish(tmp, out string, replace bool, names []string) error {
	entries, err := os.ReadDir(out)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var existing []string
	for _, n := range names {
		for _, e := range entries {
			if e.Name() == n {
				existing = append(existing, n)
			}
		}
	}
	sort.Strings(existing)
	if len(existing) > 0 && !replace {
		return fmt.Errorf("refusing to overwrite existing evidence in %s (%s); pass --replace to replace it", out, strings.Join(existing, ", "))
	}
	if len(existing) > 0 {
		fmt.Printf("replacing %d existing evidence files in %s\n", len(existing), out)
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	sort.Strings(names)
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(tmp, n))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(out, n), b, 0o644); err != nil {
			return err
		}
	}
	fmt.Printf("wrote %d evidence files to %s\n", len(names), out)
	return nil
}

// compareSemantic compares the deterministic parts of a fresh run with committed evidence.
// Timestamps, container and run identifiers live under "provenance" and are not compared.
func compareSemantic(fresh []byte, dir string) error {
	old, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if os.IsNotExist(err) {
		fmt.Printf("no committed evidence at %s; checked in-run assertions only\n", dir)
		return nil
	}
	if err != nil {
		return err
	}
	render := func(raw []byte) ([]string, error) {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, err
		}
		var lines []string
		for _, key := range []string{"pinned", "groundTruth", "semantic"} {
			var v any
			if err := json.Unmarshal(m[key], &v); err != nil {
				return nil, err
			}
			b, _ := json.MarshalIndent(map[string]any{key: v}, "", " ")
			lines = append(lines, strings.Split(string(b), "\n")...)
		}
		return lines, nil
	}
	a, err := render(old)
	if err != nil {
		return err
	}
	b, err := render(fresh)
	if err != nil {
		return err
	}
	for i := 0; i < len(a) || i < len(b); i++ {
		if i >= len(a) || i >= len(b) || a[i] != b[i] {
			var x, y string
			if i < len(a) {
				x = a[i]
			}
			if i < len(b) {
				y = b[i]
			}
			return fmt.Errorf("semantic difference from committed evidence at line %d:\n  committed: %s\n  fresh:     %s", i+1, strings.TrimSpace(x), strings.TrimSpace(y))
		}
	}
	fmt.Printf("fresh run matches the semantic content of the committed evidence in %s\n", dir)
	return nil
}
