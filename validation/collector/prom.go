package main

import (
	"context"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// Scope of this file: a minimal, strict reader for the text exposition emitted by the selected
// Collector Prometheus exporter, used only to cross-check one counter family against OTLP.
// It is lab evidence code, not a Prometheus/OpenMetrics parser and not an OverflowLens input format.

const (
	classicAccept = "text/plain;version=0.0.4;q=1.0,*/*;q=0.1"
	openAccept    = "application/openmetrics-text;version=1.0.0;q=1.0,text/plain;version=0.0.4;q=0.5,*/*;q=0.1"
	familyStem    = "http_server_requests"
)

type scrape struct {
	Accept, ContentType string
	Body                []byte
}

func doScrape(ctx context.Context, addr, accept string) (scrape, error) {
	ctx, cancel := context.WithTimeout(ctx, stepTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/metrics", nil)
	if err != nil {
		return scrape{}, err
	}
	req.Header.Set("Accept", accept)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return scrape{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return scrape{}, err
	}
	if resp.StatusCode != http.StatusOK || len(body) > maxBody {
		return scrape{}, fmt.Errorf("scrape status %d, %d bytes", resp.StatusCode, len(body))
	}
	return scrape{Accept: accept, ContentType: resp.Header.Get("Content-Type"), Body: body}, nil
}

type sample struct {
	Name   string
	Labels map[string]string
	Value  string
}

var nameRe = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*`)

// readExposition returns TYPE declarations and samples. Lines it does not understand fail the lab.
func readExposition(body []byte) (map[string]string, []sample, error) {
	types := map[string]string{}
	var samples []sample
	for n, line := range strings.Split(string(body), "\n") {
		switch {
		case line == "":
		case strings.HasPrefix(line, "# TYPE "):
			f := strings.Fields(line)
			if len(f) != 4 {
				return nil, nil, fmt.Errorf("line %d: malformed TYPE", n+1)
			}
			types[f[2]] = f[3]
		case strings.HasPrefix(line, "#"):
		default:
			s, err := readSample(line)
			if err != nil {
				return nil, nil, fmt.Errorf("line %d: %w", n+1, err)
			}
			samples = append(samples, s)
		}
	}
	return types, samples, nil
}

func readSample(line string) (sample, error) {
	name := nameRe.FindString(line)
	if name == "" {
		return sample{}, fmt.Errorf("no metric name in %q", line)
	}
	s := sample{Name: name, Labels: map[string]string{}}
	rest := line[len(name):]
	if strings.HasPrefix(rest, "{") {
		rest = rest[1:]
		for !strings.HasPrefix(rest, "}") {
			key := nameRe.FindString(rest)
			if key == "" || !strings.HasPrefix(rest[len(key):], `="`) {
				return s, fmt.Errorf("unsupported label syntax near %q", rest)
			}
			rest = rest[len(key)+2:]
			var value strings.Builder
			for {
				if rest == "" {
					return s, fmt.Errorf("unterminated label value")
				}
				c := rest[0]
				rest = rest[1:]
				if c == '"' {
					break
				}
				if c == '\\' {
					if rest == "" {
						return s, fmt.Errorf("dangling escape")
					}
					switch rest[0] {
					case 'n':
						c = '\n'
					case '\\', '"':
						c = rest[0]
					default:
						return s, fmt.Errorf("unsupported escape \\%c", rest[0])
					}
					rest = rest[1:]
				}
				value.WriteByte(c)
			}
			if _, dup := s.Labels[key]; dup {
				return s, fmt.Errorf("duplicate label %s", key)
			}
			s.Labels[key] = value.String()
			rest = strings.TrimPrefix(rest, ",")
		}
		rest = rest[1:]
	}
	fields := strings.Fields(rest)
	if len(fields) != 1 {
		return s, fmt.Errorf("expected only a value (no timestamp or exemplar) in %q", line)
	}
	s.Value = fields[0]
	return s, nil
}

func integerValue(text string) (int64, error) {
	f, _, err := big.ParseFloat(text, 10, 128, big.ToNearestEven)
	if err != nil || !f.IsInt() {
		return 0, fmt.Errorf("value %q is not an exact integer", text)
	}
	n, _ := f.Int64()
	return n, nil
}

type promSample struct {
	Labels map[string]string `json:"labels"`
	Value  int64             `json:"value"`
}

// promEvidence is the cross-checked content of one scrape of the selected counter family.
type promEvidence struct {
	ContentType     string       `json:"contentType"`
	Family          string       `json:"family"`
	Type            string       `json:"type"`
	OverflowLabel   string       `json:"overflowLabel"`
	OutcomeLabel    string       `json:"outcomeLabel"`
	RequestIDLabel  string       `json:"requestIdLabel"`
	ResourceScope   []string     `json:"resourceAndScopeLabels"`
	Samples         []promSample `json:"samples"`
	Total           int64        `json:"total"`
	OverflowTotal   int64        `json:"overflowTotal"`
	ExcludedSamples []string     `json:"excludedSampleNames"`
}

// checkProm cross-checks the selected family against the OTLP stream received by the sink.
// Label names are derived from the values of the known points, not assumed.
func checkProm(s scrape, want stream) (promEvidence, error) {
	ev := promEvidence{ContentType: s.ContentType}
	types, all, err := readExposition(s.Body)
	if err != nil {
		return ev, err
	}
	var families []string
	for name, kind := range types {
		if strings.Contains(name, familyStem) && kind == "counter" {
			families = append(families, name)
		}
	}
	if len(families) != 1 {
		return ev, fmt.Errorf("expected exactly one counter family containing %q, got %v", familyStem, families)
	}
	ev.Family, ev.Type = families[0], types[families[0]]
	sampleName := ev.Family
	if strings.HasPrefix(s.ContentType, "application/openmetrics-text") && !strings.HasSuffix(sampleName, "_total") {
		sampleName += "_total"
	}
	excluded := map[string]bool{}
	var family []sample
	for _, x := range all {
		if x.Name == sampleName {
			family = append(family, x)
		} else {
			excluded[x.Name] = true
		}
	}
	for name := range excluded {
		ev.ExcludedSamples = append(ev.ExcludedSamples, name)
	}
	sort.Strings(ev.ExcludedSamples)
	if ev.ExcludedSamples == nil {
		ev.ExcludedSamples = []string{}
	}
	if len(family) != len(want.Points) {
		return ev, fmt.Errorf("%d family samples for %d OTLP points", len(family), len(want.Points))
	}
	return deriveLabels(ev, family, want)
}

func pointValues(key string) (requestID, outcome string) {
	for _, part := range strings.Split(key, ",") {
		switch {
		case strings.HasPrefix(part, "request.id=s:"):
			requestID = strings.TrimPrefix(part, "request.id=s:")
		case strings.HasPrefix(part, "success=b:"):
			outcome = strings.TrimPrefix(part, "success=b:")
		}
	}
	return
}

// deriveLabels finds the translated label names from the values of the known points.
func deriveLabels(ev promEvidence, family []sample, want stream) (promEvidence, error) {
	// Request IDs are unique per ordinary point, so the label carrying them identifies the
	// translated request.id label; the outcome label is the one whose value is the point's outcome.
	var ridLabel, outcomeLabel string
	for key, p := range want.Points {
		if p.Overflow {
			continue
		}
		rid, outcome := pointValues(key)
		var matches []sample
		for _, x := range family {
			for _, v := range x.Labels {
				if v == rid {
					matches = append(matches, x)
					break
				}
			}
		}
		if len(matches) != 1 {
			return ev, fmt.Errorf("request ID %q matches %d samples", rid, len(matches))
		}
		for k, v := range matches[0].Labels {
			if v == rid && (ridLabel == "" || ridLabel == k) {
				ridLabel = k
			}
			if v == outcome && k != ridLabel && (outcomeLabel == "" || outcomeLabel == k) {
				outcomeLabel = k
			}
		}
	}
	if ridLabel == "" || outcomeLabel == "" || ridLabel == outcomeLabel {
		return ev, fmt.Errorf("could not derive label translation (request id %q, outcome %q)", ridLabel, outcomeLabel)
	}
	ev.RequestIDLabel, ev.OutcomeLabel = ridLabel, outcomeLabel
	remaining := map[string]sample{}
	hasOverflow := false
	for _, x := range family {
		if _, ok := x.Labels[ridLabel]; ok {
			remaining[x.Labels[ridLabel]] = x
			continue
		}
		// The only sample without the request ID is the overflow series.
		if hasOverflow {
			return ev, fmt.Errorf("more than one sample without request ID label")
		}
		hasOverflow = true
		remaining[""] = x
	}
	common := map[string]bool{}
	for k := range family[0].Labels {
		common[k] = true
	}
	for _, x := range family {
		for k := range common {
			if _, ok := x.Labels[k]; !ok {
				delete(common, k)
			}
		}
	}
	if hasOverflow {
		var extra []string
		for k := range remaining[""].Labels {
			if !common[k] {
				extra = append(extra, k)
			}
		}
		if len(extra) != 1 || remaining[""].Labels[extra[0]] != "true" {
			return ev, fmt.Errorf("overflow sample labels are not a single true marker: %v", remaining[""].Labels)
		}
		ev.OverflowLabel = extra[0]
	}
	for k := range common {
		if k != ridLabel && k != outcomeLabel {
			ev.ResourceScope = append(ev.ResourceScope, k)
		}
	}
	sort.Strings(ev.ResourceScope)
	matched := 0
	for key, p := range want.Points {
		var x sample
		if p.Overflow {
			x = remaining[""]
		} else {
			rid, outcome := pointValues(key)
			x = remaining[rid]
			if x.Labels[outcomeLabel] != outcome {
				return ev, fmt.Errorf("point %s has outcome label %q", key, x.Labels[outcomeLabel])
			}
		}
		n, err := integerValue(x.Value)
		if err != nil || n != p.Value {
			return ev, fmt.Errorf("point %s: OTLP has %d, exposition has %q (%v)", key, p.Value, x.Value, err)
		}
		matched++
	}
	if matched != len(family) {
		return ev, fmt.Errorf("matched %d of %d samples", matched, len(family))
	}
	for _, x := range family {
		n, _ := integerValue(x.Value)
		ev.Samples = append(ev.Samples, promSample{Labels: x.Labels, Value: n})
		ev.Total += n
		if _, ok := x.Labels[ridLabel]; !ok {
			ev.OverflowTotal += n
		}
	}
	sort.Slice(ev.Samples, func(i, j int) bool {
		return fmt.Sprint(ev.Samples[i].Labels) < fmt.Sprint(ev.Samples[j].Labels)
	})
	return ev, nil
}
