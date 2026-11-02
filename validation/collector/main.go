// Collector lab: real SDK → official OTLP exporter → pinned OpenTelemetry Collector → OTLP sink,
// with the Collector's Prometheus exporter as an independent evidence channel.
//
//	go run ./collector prepare            pull the digest-pinned image (the only network step)
//	go run ./collector run [flags]        run both pipelines on disposable loopback resources
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	imageName    = "otel/opentelemetry-collector-contrib"
	imageVersion = "0.163.2"
	// Manifest-list digest of the multi-arch image published for tag 0.163.2.
	imageDigest = "sha256:7f22d2a6748110ffb6a59bc0df448bccbf501cdb667d610ede4c61d3863d5849"
	imageRef    = imageName + "@" + imageDigest
	labLabel    = "overflowlens.lab=collector"
	runDeadline = 3 * time.Minute
	stepTimeout = 20 * time.Second
	maxOutput   = 1 << 20
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "collector lab:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: collector prepare | run [--out DIR [--replace]] [--compare DIR]")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch os.Args[1] {
	case "prepare":
		return prepare(ctx)
	case "run":
		fs := flag.NewFlagSet("run", flag.ContinueOnError)
		out := fs.String("out", "", "write captured evidence to this directory (default: verify only)")
		replace := fs.Bool("replace", false, "allow --out to overwrite existing lab evidence files")
		compare := fs.String("compare", filepath.Join("..", "fixtures", "collector"), "committed evidence to compare semantically when --out is not set")
		if err := fs.Parse(os.Args[2:]); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(ctx, runDeadline)
		defer cancel()
		return runLab(ctx, *out, *replace, *compare)
	}
	return fmt.Errorf("unknown command %q", os.Args[1])
}

// docker runs the Docker CLI with bounded output.
func docker(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	out := &capped{limit: maxOutput}
	cmd.Stdout, cmd.Stderr = out, out
	err := cmd.Run()
	if err != nil {
		return out.String(), fmt.Errorf("docker %s: %w: %s", args[0], err, strings.TrimSpace(out.String()))
	}
	return out.String(), nil
}

type capped struct {
	bytes.Buffer
	limit int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.limit - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

func prepare(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	fmt.Println("pulling", imageRef)
	if _, err := docker(ctx, "pull", "--quiet", imageRef); err != nil {
		return err
	}
	info, err := inspectImage(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("ready: %s %s/%s id=%s\n", imageRef, info.Os, info.Architecture, info.ID)
	return nil
}

type imageInfo struct {
	ID           string   `json:"imageId"`
	Os           string   `json:"os"`
	Architecture string   `json:"architecture"`
	RepoDigests  []string `json:"repoDigests"`
}

func inspectImage(ctx context.Context) (imageInfo, error) {
	var info imageInfo
	out, err := docker(ctx, "image", "inspect", "--format", `{"imageId":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"repoDigests":{{json .RepoDigests}}}`, imageRef)
	if err != nil {
		return info, fmt.Errorf("image is not available locally; run `npm run validate:collector:prepare` first: %w", err)
	}
	if err = json.Unmarshal([]byte(out), &info); err != nil {
		return info, err
	}
	for _, d := range info.RepoDigests {
		if strings.HasSuffix(d, "@"+imageDigest) {
			return info, nil
		}
	}
	return info, fmt.Errorf("local image does not carry pinned digest %s: %v", imageDigest, info.RepoDigests)
}

// provenance gathers runtime facts that identify the pinned pipeline. It is not compared semantically.
func provenance(ctx context.Context, info imageInfo) (map[string]any, error) {
	version, err := docker(ctx, "run", "--rm", "--pull=never", "--network", "none", imageRef, "--version")
	if err != nil {
		return nil, err
	}
	components, err := docker(ctx, "run", "--rm", "--pull=never", "--network", "none", imageRef, "components")
	if err != nil {
		return nil, err
	}
	server, err := docker(ctx, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"collector": map[string]any{
			"image": imageName, "tag": imageVersion, "digest": imageDigest, "reference": imageRef,
			"local": info, "version": strings.TrimSpace(version), "usedComponents": usedComponents(components),
		},
		"runtime": map[string]any{
			"hostOs": runtime.GOOS, "hostArch": runtime.GOARCH, "go": runtime.Version(), "docker": strings.TrimSpace(server),
			"container": "read-only root, all capabilities dropped, no-new-privileges, 256 MiB memory, 1 CPU, 128 PIDs, ports published on 127.0.0.1 only, no Docker socket, not privileged",
		},
		"sdk": "go.opentelemetry.io/otel/sdk/metric v1.47.0 → otlpmetrichttp v1.47.0 → Collector → OTLP/HTTP protobuf sink → protojson v1.36.12 (UseEnumNumbers)",
	}, nil
}

// usedComponents extracts module versions of the components used by the lab configs from the
// `components` listing: lines "  - name: X" followed by "    module: M" under a section header.
func usedComponents(listing string) []string {
	wanted := map[string]bool{
		"receivers/otlp": true, "processors/filter": true, "exporters/otlp_http": true,
		"exporters/prometheus": true, "extensions/health_check": true,
	}
	var section, name string
	var found []string
	for _, line := range strings.Split(listing, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case line != "" && line[0] != ' ' && strings.HasSuffix(trimmed, ":"):
			section = strings.TrimSuffix(trimmed, ":")
		case strings.HasPrefix(trimmed, "- name: "):
			name = strings.TrimPrefix(trimmed, "- name: ")
		case strings.HasPrefix(trimmed, "module: ") && wanted[section+"/"+name]:
			found = append(found, section+"/"+name+" "+strings.TrimPrefix(trimmed, "module: "))
		}
	}
	sort.Strings(found)
	return found
}
