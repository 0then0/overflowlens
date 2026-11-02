package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	collectorpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
)

const (
	maxExports = 8
	maxBody    = 1 << 20
)

// sink is the disposable OTLP/HTTP receiver at the end of the Collector pipeline. It keeps the
// raw protobuf of every export it acknowledges, within fixed count and size limits.
type sink struct {
	listener net.Listener
	server   *http.Server
	mu       sync.Mutex
	bodies   [][]byte
	failure  error
	arrived  chan struct{}
}

func newSink() (*sink, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &sink{listener: listener, arrived: make(chan struct{}, maxExports+1)}
	s.server = &http.Server{Handler: http.HandlerFunc(s.handle), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = s.server.Serve(listener) }()
	return s, nil
}

func (s *sink) port() int { return s.listener.Addr().(*net.TCPAddr).Port }

func (s *sink) close() { _ = s.server.Close() }

func (s *sink) reject(w http.ResponseWriter, status int, err error) {
	s.mu.Lock()
	if s.failure == nil {
		s.failure = err
	}
	s.mu.Unlock()
	http.Error(w, err.Error(), status)
}

func (s *sink) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/v1/metrics" {
		s.reject(w, http.StatusNotFound, fmt.Errorf("unexpected request %s %s", r.Method, r.URL.Path))
		return
	}
	if ct := r.Header.Get("Content-Type"); ct != "application/x-protobuf" || r.Header.Get("Content-Encoding") != "" {
		s.reject(w, http.StatusUnsupportedMediaType, fmt.Errorf("unexpected content type %q or encoding %q", ct, r.Header.Get("Content-Encoding")))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err == nil {
		err = proto.Unmarshal(body, new(collectorpb.ExportMetricsServiceRequest))
	}
	if err != nil {
		s.reject(w, http.StatusBadRequest, err)
		return
	}
	s.mu.Lock()
	if len(s.bodies) >= maxExports {
		s.mu.Unlock()
		s.reject(w, http.StatusTooManyRequests, fmt.Errorf("export limit %d exceeded", maxExports))
		return
	}
	s.bodies = append(s.bodies, body)
	s.mu.Unlock()
	s.arrived <- struct{}{}
	reply, _ := proto.Marshal(new(collectorpb.ExportMetricsServiceResponse))
	w.Header().Set("Content-Type", "application/x-protobuf")
	_, _ = w.Write(reply)
}

// waitFor blocks until the sink has acknowledged n exports, or the deadline or a sink failure ends it.
func (s *sink) waitFor(ctx context.Context, n int) ([]byte, error) {
	for {
		s.mu.Lock()
		failure, count := s.failure, len(s.bodies)
		var body []byte
		if count >= n {
			body = s.bodies[n-1]
		}
		s.mu.Unlock()
		if failure != nil {
			return nil, failure
		}
		if count > n {
			return nil, fmt.Errorf("sink holds %d exports while expecting %d", count, n)
		}
		if count == n {
			return body, nil
		}
		select {
		case <-s.arrived:
		case <-ctx.Done():
			return nil, fmt.Errorf("export %d was not acknowledged by the sink: %w", n, ctx.Err())
		}
	}
}

func (s *sink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.bodies)
}

// collector is one disposable container started from the pinned image.
type collector struct {
	name                           string
	otlpAddr, promAddr, healthAddr string
}

func randomName() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "overflowlens-lab-" + hex.EncodeToString(b)
}

func startCollector(ctx context.Context, config string, sinkPort int) (*collector, error) {
	abs, err := filepath.Abs(config)
	if err != nil {
		return nil, err
	}
	c := &collector{name: randomName()}
	_, err = docker(ctx, "run", "--detach", "--pull=never", "--name", c.name, "--label", labLabel,
		"--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "128",
		"--add-host", "host.docker.internal:host-gateway",
		"-p", "127.0.0.1::4318", "-p", "127.0.0.1::8889", "-p", "127.0.0.1::13133",
		"-e", fmt.Sprintf("OVERFLOWLENS_SINK_ENDPOINT=http://host.docker.internal:%d", sinkPort),
		"-v", abs+":/etc/otelcol/config.yaml:ro",
		imageRef, "--config=/etc/otelcol/config.yaml")
	if err != nil {
		c.stop()
		return nil, err
	}
	// The container must be the pinned image, unprivileged, with only the read-only config mounted.
	out, err := docker(ctx, "inspect", "--format", "{{.Config.Image}}|{{.HostConfig.Privileged}}|{{len .Mounts}}|{{.HostConfig.ReadonlyRootfs}}", c.name)
	if err != nil || strings.TrimSpace(out) != imageRef+"|false|1|true" {
		c.stop()
		return nil, fmt.Errorf("unexpected container configuration %q: %v", strings.TrimSpace(out), err)
	}
	for _, p := range []struct {
		port string
		addr *string
	}{{"4318", &c.otlpAddr}, {"8889", &c.promAddr}, {"13133", &c.healthAddr}} {
		out, err := docker(ctx, "port", c.name, p.port+"/tcp")
		if err != nil {
			c.stop()
			return nil, err
		}
		*p.addr = strings.Fields(out)[0]
		if !strings.HasPrefix(*p.addr, "127.0.0.1:") {
			c.stop()
			return nil, fmt.Errorf("port %s is published on %q, not loopback", p.port, *p.addr)
		}
	}
	return c, nil
}

// waitReady polls the health_check extension. Readiness only means the pipelines started; it is
// not evidence that any export arrived.
func (c *collector) waitReady(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, stepTimeout)
	defer cancel()
	for {
		running, err := docker(ctx, "inspect", "--format", "{{.State.Running}}", c.name)
		if err != nil || strings.TrimSpace(running) != "true" {
			return fmt.Errorf("collector is not running: %v\n%s", err, c.logs())
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+c.healthAddr+"/", nil)
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBody))
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-ctx.Done():
			return fmt.Errorf("collector did not become ready: %w\n%s", ctx.Err(), c.logs())
		}
	}
}

func (c *collector) logs() string {
	ctx, cancel := context.WithTimeout(context.Background(), stepTimeout)
	defer cancel()
	out, _ := docker(ctx, "logs", "--tail", "40", c.name)
	return out
}

// stop removes the container regardless of the state of the run context.
func (c *collector) stop() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "docker", "rm", "--force", "--volumes", c.name).Run()
}
