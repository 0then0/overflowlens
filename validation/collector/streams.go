package main

import (
	"fmt"
	"sort"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	collectorpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/proto"
)

const overflowKey = "otel.metric.overflow"

// observation is one independently recorded request outcome with its multiplicity.
type observation struct {
	Success   bool   `json:"success"`
	RequestID string `json:"requestId"`
	Count     int64  `json:"count"`
}

// The lab records the same workload as the SDK harness: 900 known successes, 1 known error and
// 99 unique requests (33 failed). The truth is 34 errors among 1,000 requests. The baseline is
// recorded before the first snapshot so that cumulative exclusion is observable.
func workload() []observation {
	obs := []observation{{true, "known-success", 900}, {false, "known-error", 1}}
	for i := 0; i < 99; i++ {
		obs = append(obs, observation{i%3 != 0, fmt.Sprintf("unique-%03d", i), 1})
	}
	return obs
}

func baseline() []observation {
	return []observation{{true, "known-success", 100}, {false, "known-error", 7}, {true, "baseline-overflow", 5}}
}

func truth(obs []observation) (total, errors int64) {
	for _, o := range obs {
		total += o.Count
		if !o.Success {
			errors += o.Count
		}
	}
	return
}

type point struct {
	Start, Time uint64
	Value       int64
	Overflow    bool
	Error       bool
}

// stream is the normalized content of one exported request counter, independent of point order.
type stream struct {
	Resource, ScopeName, ScopeVersion, Name, Unit string
	Cumulative, Monotonic                         bool
	Points                                        map[string]point
}

type kv struct{ key, val string }

func canonical(pairs []kv) string {
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].key < pairs[j].key })
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = p.key + "=" + p.val
	}
	return strings.Join(parts, ",")
}

func classify(attrs string, pairs []kv) (overflow, isError bool, err error) {
	if attrs == overflowKey+"=b:true" {
		return true, false, nil
	}
	for _, p := range pairs {
		if p.key == "success" && (p.val == "b:true" || p.val == "b:false") {
			return false, p.val == "b:false", nil
		}
	}
	return false, false, fmt.Errorf("point has neither the SDK overflow shape nor a boolean outcome: %s", attrs)
}

func fromSDK(rm *metricdata.ResourceMetrics) (stream, error) {
	if len(rm.ScopeMetrics) != 1 || len(rm.ScopeMetrics[0].Metrics) != 1 {
		return stream{}, fmt.Errorf("expected one scope with one metric")
	}
	sm, m := rm.ScopeMetrics[0], rm.ScopeMetrics[0].Metrics[0]
	sum, ok := m.Data.(metricdata.Sum[int64])
	if !ok {
		return stream{}, fmt.Errorf("SDK metric is not an integer Sum")
	}
	var res []kv
	for _, a := range rm.Resource.Attributes() {
		res = append(res, kv{string(a.Key), "s:" + a.Value.Emit()})
	}
	s := stream{Resource: canonical(res), ScopeName: sm.Scope.Name, ScopeVersion: sm.Scope.Version, Name: m.Name, Unit: m.Unit,
		Cumulative: sum.Temporality == metricdata.CumulativeTemporality, Monotonic: sum.IsMonotonic, Points: map[string]point{}}
	for _, dp := range sum.DataPoints {
		var pairs []kv
		for _, a := range dp.Attributes.ToSlice() {
			switch a.Value.Type() {
			case attribute.BOOL:
				pairs = append(pairs, kv{string(a.Key), fmt.Sprintf("b:%t", a.Value.AsBool())})
			case attribute.STRING:
				pairs = append(pairs, kv{string(a.Key), "s:" + a.Value.AsString()})
			default:
				return s, fmt.Errorf("unexpected attribute type for %s", a.Key)
			}
		}
		key := canonical(pairs)
		overflow, isError, err := classify(key, pairs)
		if err != nil {
			return s, err
		}
		s.Points[key] = point{Start: uint64(dp.StartTime.UnixNano()), Time: uint64(dp.Time.UnixNano()), Value: dp.Value, Overflow: overflow, Error: isError}
	}
	return s, nil
}

// fromProtobuf decodes the raw protobuf received by the sink; it does not use the SDK structures.
func fromProtobuf(raw []byte) (stream, error) {
	var req collectorpb.ExportMetricsServiceRequest
	if err := proto.Unmarshal(raw, &req); err != nil {
		return stream{}, err
	}
	if len(req.ResourceMetrics) != 1 || len(req.ResourceMetrics[0].ScopeMetrics) != 1 || len(req.ResourceMetrics[0].ScopeMetrics[0].Metrics) != 1 {
		return stream{}, fmt.Errorf("expected one resource, one scope and one metric")
	}
	rm := req.ResourceMetrics[0]
	sm := rm.ScopeMetrics[0]
	m := sm.Metrics[0]
	sum := m.GetSum()
	if sum == nil {
		return stream{}, fmt.Errorf("metric %q is not a Sum", m.Name)
	}
	var res []kv
	for _, a := range rm.GetResource().GetAttributes() {
		res = append(res, kv{a.Key, "s:" + a.Value.GetStringValue()})
	}
	s := stream{Resource: canonical(res), ScopeName: sm.GetScope().GetName(), ScopeVersion: sm.GetScope().GetVersion(), Name: m.Name, Unit: m.Unit,
		Cumulative: sum.AggregationTemporality == metricspb.AggregationTemporality_AGGREGATION_TEMPORALITY_CUMULATIVE, Monotonic: sum.IsMonotonic, Points: map[string]point{}}
	for _, dp := range sum.DataPoints {
		v, ok := dp.Value.(*metricspb.NumberDataPoint_AsInt)
		if !ok || dp.Flags != 0 {
			return s, fmt.Errorf("point is not a flag-free integer")
		}
		var pairs []kv
		for _, a := range dp.Attributes {
			switch value := a.Value.Value.(type) {
			case *commonpb.AnyValue_BoolValue:
				pairs = append(pairs, kv{a.Key, fmt.Sprintf("b:%t", value.BoolValue)})
			case *commonpb.AnyValue_StringValue:
				pairs = append(pairs, kv{a.Key, "s:" + value.StringValue})
			default:
				return s, fmt.Errorf("unexpected attribute type for %s", a.Key)
			}
		}
		key := canonical(pairs)
		overflow, isError, err := classify(key, pairs)
		if err != nil {
			return s, err
		}
		if _, dup := s.Points[key]; dup {
			return s, fmt.Errorf("duplicate measurement identity %s", key)
		}
		s.Points[key] = point{Start: dp.StartTimeUnixNano, Time: dp.TimeUnixNano, Value: v.AsInt, Overflow: overflow, Error: isError}
	}
	return s, nil
}

func sameIdentity(a, b stream) bool {
	return a.Resource == b.Resource && a.ScopeName == b.ScopeName && a.ScopeVersion == b.ScopeVersion &&
		a.Name == b.Name && a.Unit == b.Unit && a.Cumulative == b.Cumulative && a.Monotonic == b.Monotonic
}

// preserved checks that the Collector output equals the SDK stream, optionally minus overflow
// points, and returns the removed points. Identity, temporality, timestamps and values must be unchanged.
func preserved(sdk, out stream, dropOverflow bool) (removed map[string]point, err error) {
	if !sameIdentity(sdk, out) || !out.Cumulative || !out.Monotonic {
		return nil, fmt.Errorf("stream identity or cumulative temporality changed: sdk=%+v out=%+v", sdk.Name, out.Name)
	}
	removed = map[string]point{}
	for key, p := range sdk.Points {
		q, ok := out.Points[key]
		switch {
		case !ok && dropOverflow && p.Overflow:
			removed[key] = p
		case !ok:
			return nil, fmt.Errorf("point %s disappeared", key)
		case q != p:
			return nil, fmt.Errorf("point %s changed: sdk=%+v collector=%+v", key, p, q)
		}
	}
	for key := range out.Points {
		if _, ok := sdk.Points[key]; !ok {
			return nil, fmt.Errorf("point %s appeared", key)
		}
	}
	return removed, nil
}

type counts struct{ K, E, O, T int64 }

// window subtracts two cumulative snapshots point by point, as the contract requires: matching
// identity sets, unchanged starts, ordered collections and nondecreasing counts.
func window(before, after stream) (counts, error) {
	var c counts
	if !sameIdentity(before, after) || len(before.Points) != len(after.Points) {
		return c, fmt.Errorf("snapshots are not comparable")
	}
	for key, a := range after.Points {
		b, ok := before.Points[key]
		if !ok || a.Start != b.Start || a.Time <= b.Time || a.Value < b.Value {
			return c, fmt.Errorf("point %s violates cumulative continuity", key)
		}
		n := a.Value - b.Value
		if a.Overflow {
			c.O += n
		} else {
			c.K += n
			if a.Error {
				c.E += n
			}
		}
	}
	c.T = c.K + c.O
	return c, nil
}

func cumulativeTotal(s stream) (total, overflow int64) {
	for _, p := range s.Points {
		total += p.Value
		if p.Overflow {
			overflow += p.Value
		}
	}
	return
}
