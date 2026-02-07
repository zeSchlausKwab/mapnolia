package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Chunker handles PMTiles extraction and chunking
type Chunker struct {
	mu         sync.Mutex
	pmtilesBin string
	outputDir  string
	jobs       map[string]*ChunkJob
}

// ChunkJob tracks a chunking operation
type ChunkJob struct {
	SourceID    string  `json:"sourceId"`
	Status      string  `json:"status"` // pending, downloading, chunking, ready, error
	Progress    float64 `json:"progress"`
	Error       string  `json:"error,omitempty"`
	TotalChunks int     `json:"totalChunks"`
	DoneChunks  int     `json:"doneChunks"`
	CurrentTask string  `json:"currentTask,omitempty"` // Description of current operation
}

// PMTilesHeader represents metadata from a PMTiles file
type PMTilesHeader struct {
	TileCompression string     `json:"tile_compression"`
	TileType        string     `json:"tile_type"`
	MinZoom         int        `json:"minzoom"`
	MaxZoom         int        `json:"maxzoom"`
	Bounds          [4]float64 `json:"bounds"`
	Center          [3]float64 `json:"center"`
}

// FetchPMTilesMetadata fetches metadata from a PMTiles file using the CLI
func (c *Chunker) FetchPMTilesMetadata(url string) (*PMTilesHeader, error) {
	if c.pmtilesBin == "" {
		return nil, fmt.Errorf("pmtiles binary not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, c.pmtilesBin, "show", "--header-json", url)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to fetch metadata: %w", err)
	}

	var header PMTilesHeader
	if err := json.Unmarshal(output, &header); err != nil {
		return nil, fmt.Errorf("failed to parse metadata: %w", err)
	}

	return &header, nil
}

// DownloadedFile represents a downloaded PMTiles file
type DownloadedFile struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	IsRemote  bool   `json:"isRemote"`
	SourceURL string `json:"sourceUrl,omitempty"`
}

var chunker *Chunker

func initChunker() error {
	binPath, err := findPmtilesBinary()
	if err != nil {
		slog.Warn("pmtiles binary not found", "error", err)
		binPath = "" // Will fail gracefully when trying to chunk
	} else {
		slog.Info("found pmtiles binary", "path", binPath)
	}

	chunker = &Chunker{
		pmtilesBin: binPath,
		outputDir:  filepath.Join(config.DataDir, "chunks"),
		jobs:       make(map[string]*ChunkJob),
	}

	if err := os.MkdirAll(chunker.outputDir, 0755); err != nil {
		return fmt.Errorf("failed to create chunks directory: %w", err)
	}

	return nil
}

func findPmtilesBinary() (string, error) {
	// Check common locations
	candidates := []string{
		"pmtiles",                    // In PATH
		"../bin/pmtiles",             // Project bin directory
		"../bin/pmtiles-mac-silicon", // Mac Silicon specific
		"../bin/pmtiles-linux-amd64", // Linux specific
	}

	// Add platform-specific binary
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			candidates = append([]string{"../bin/pmtiles-mac-silicon"}, candidates...)
		}
	case "linux":
		candidates = append([]string{"../bin/pmtiles-linux-amd64"}, candidates...)
	}

	for _, c := range candidates {
		// Try to resolve path
		path := c
		if !filepath.IsAbs(path) && !strings.HasPrefix(path, "/") {
			// Make relative to server directory
			if abs, err := filepath.Abs(path); err == nil {
				path = abs
			}
		}

		if _, err := os.Stat(path); err == nil {
			// Verify it's executable
			if err := exec.Command(path, "--version").Run(); err == nil {
				return path, nil
			}
		}

		// Try PATH lookup
		if found, err := exec.LookPath(c); err == nil {
			return found, nil
		}
	}

	return "", fmt.Errorf("pmtiles binary not found in any expected location")
}

// StartChunking begins chunking a layer
func (c *Chunker) StartChunking(ctx context.Context, layer *MapLayer, source *Source) error {
	c.mu.Lock()
	if _, exists := c.jobs[layer.ID]; exists {
		c.mu.Unlock()
		return fmt.Errorf("chunking already in progress for layer %s", layer.ID)
	}

	job := &ChunkJob{
		SourceID: layer.ID,
		Status:   "pending",
	}
	c.jobs[layer.ID] = job
	c.mu.Unlock()

	go c.runChunking(ctx, layer, source, job)
	return nil
}

func (c *Chunker) runChunking(ctx context.Context, layer *MapLayer, source *Source, job *ChunkJob) {
	defer func() {
		// Update layer status in config
		for i := range config.MapLayers {
			if config.MapLayers[i].ID == layer.ID {
				config.MapLayers[i].Status = job.Status
				config.MapLayers[i].Error = job.Error
				break
			}
		}
		config.Save("")
	}()

	// Resolve input file from source
	inputPath, err := c.resolveInput(ctx, source, job)
	if err != nil {
		job.Status = "error"
		job.Error = err.Error()
		slog.Error("failed to resolve input", "layer", layer.ID, "source", source.ID, "error", err)
		return
	}

	// Generate geohashes for the given precision
	geohashes := generateGeohashes(layer.Precision)
	job.TotalChunks = len(geohashes)
	job.Status = "chunking"

	slog.Info("starting chunking",
		"layer", layer.ID,
		"source", source.ID,
		"precision", layer.Precision,
		"chunks", len(geohashes),
		"minZoom", layer.MinZoom,
		"maxZoom", layer.MaxZoom,
	)

	announcement, _ := loadAnnouncement()

	for i, gh := range geohashes {
		select {
		case <-ctx.Done():
			job.Status = "error"
			job.Error = "cancelled"
			return
		default:
		}

		bbox := geohashToBBox(gh)
		outputPath := filepath.Join(c.outputDir, fmt.Sprintf("%s.pmtiles", gh))

		if err := c.extractRegion(ctx, inputPath, outputPath, bbox, layer.MinZoom, layer.MaxZoom); err != nil {
			slog.Error("failed to extract region", "geohash", gh, "error", err)
			continue
		}

		// Calculate SHA256 and rename to content-addressed name
		hash, err := hashFile(outputPath)
		if err != nil {
			slog.Error("failed to hash file", "path", outputPath, "error", err)
			continue
		}

		finalPath := filepath.Join(c.outputDir, fmt.Sprintf("%s.pmtiles", hash))
		if outputPath != finalPath {
			if _, err := os.Stat(finalPath); os.IsNotExist(err) {
				os.Rename(outputPath, finalPath)
			} else {
				os.Remove(outputPath) // Duplicate content
			}
		}

		// Get file size
		info, _ := os.Stat(finalPath)
		size := int64(0)
		if info != nil {
			size = info.Size()
		}

		// Update announcement
		announcement[gh] = ChunkInfo{
			BBox:    bbox,
			File:    fmt.Sprintf("%s.pmtiles", hash),
			MaxZoom: layer.MaxZoom,
			Size:    size,
		}

		job.DoneChunks = i + 1
		job.Progress = float64(i+1) / float64(len(geohashes)) * 100

		slog.Info("extracted chunk",
			"geohash", gh,
			"file", hash[:8],
			"size", size,
			"progress", fmt.Sprintf("%.1f%%", job.Progress),
		)
	}

	// Save announcement
	if err := saveAnnouncement(announcement); err != nil {
		slog.Error("failed to save announcement", "error", err)
	}

	job.Status = "ready"
	slog.Info("chunking complete", "layer", layer.ID, "chunks", job.DoneChunks)

	// Publish updated announcement
	go func() {
		pubCtx, cancel := context.WithTimeout(context.Background(), 30)
		defer cancel()
		PublishAnnouncement(pubCtx)
	}()
}

func (c *Chunker) resolveInput(ctx context.Context, source *Source, job *ChunkJob) (string, error) {
	url := source.URL

	// Check if it's a local file
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		// Local file - resolve relative to project root
		path := url
		if !filepath.IsAbs(path) {
			path = filepath.Join("..", path)
		}
		if _, err := os.Stat(path); err != nil {
			return "", fmt.Errorf("local file not found: %s", url)
		}
		return path, nil
	}

	// Remote URL - download first
	job.Status = "downloading"
	slog.Info("downloading remote PMTiles", "url", url)

	downloadPath := filepath.Join(config.DataDir, "downloads")
	os.MkdirAll(downloadPath, 0755)

	// Use URL hash as filename
	urlHash := sha256.Sum256([]byte(url))
	localPath := filepath.Join(downloadPath, fmt.Sprintf("%s.pmtiles", hex.EncodeToString(urlHash[:8])))

	// Check if already downloaded
	if _, err := os.Stat(localPath); err == nil {
		slog.Info("using cached download", "path", localPath)
		return localPath, nil
	}

	// Download the file
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download failed: %s", resp.Status)
	}

	f, err := os.Create(localPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	if err != nil {
		os.Remove(localPath)
		return "", err
	}

	slog.Info("download complete", "path", localPath)
	return localPath, nil
}

func (c *Chunker) extractRegion(ctx context.Context, input, output string, bbox [4]float64, minZoom, maxZoom int) error {
	if c.pmtilesBin == "" {
		return fmt.Errorf("pmtiles binary not configured")
	}

	bboxStr := fmt.Sprintf("%f,%f,%f,%f", bbox[0], bbox[1], bbox[2], bbox[3])

	args := []string{
		"extract",
		input,
		output,
		fmt.Sprintf("--bbox=%s", bboxStr),
		"--minzoom", fmt.Sprintf("%d", minZoom),
		"--maxzoom", fmt.Sprintf("%d", maxZoom),
	}

	cmd := exec.CommandContext(ctx, c.pmtilesBin, args...)
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pmtiles extract failed: %w", err)
	}

	return nil
}

// GetJob returns the current job status for a source
func (c *Chunker) GetJob(sourceID string) *ChunkJob {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.jobs[sourceID]
}

// ListDownloads returns all downloaded PMTiles files
func (c *Chunker) ListDownloads() ([]DownloadedFile, error) {
	var files []DownloadedFile

	// Check downloads directory
	downloadDir := filepath.Join(config.DataDir, "downloads")
	entries, err := os.ReadDir(downloadDir)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".pmtiles") {
			continue
		}

		path := filepath.Join(downloadDir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}

		hash, _ := hashFile(path)

		files = append(files, DownloadedFile{
			Name:     e.Name(),
			Path:     path,
			Size:     info.Size(),
			SHA256:   hash,
			IsRemote: true,
		})
	}

	// Check for local files referenced in sources
	for _, src := range config.Sources {
		if strings.HasPrefix(src.URL, "http") {
			continue
		}
		path := src.URL
		if !filepath.IsAbs(path) {
			path = filepath.Join("..", path)
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}

		hash, _ := hashFile(path)

		files = append(files, DownloadedFile{
			Name:      filepath.Base(path),
			Path:      path,
			Size:      info.Size(),
			SHA256:    hash,
			IsRemote:  false,
			SourceURL: src.URL,
		})
	}

	return files, nil
}

// Geohash utilities
var base32 = "0123456789bcdefghjkmnpqrstuvwxyz"

func generateGeohashes(precision int) []string {
	if precision <= 0 {
		precision = 1
	}
	if precision > 4 {
		precision = 4 // Limit to prevent too many chunks
	}

	var result []string
	generateGeohashesRecursive("", precision, &result)
	return result
}

func generateGeohashesRecursive(prefix string, remaining int, result *[]string) {
	if remaining == 0 {
		*result = append(*result, prefix)
		return
	}
	for _, c := range base32 {
		generateGeohashesRecursive(prefix+string(c), remaining-1, result)
	}
}

func geohashToBBox(geohash string) [4]float64 {
	minLat, maxLat := -90.0, 90.0
	minLon, maxLon := -180.0, 180.0
	isLon := true

	for _, c := range geohash {
		idx := strings.IndexRune(base32, c)
		if idx == -1 {
			continue
		}

		for bit := 4; bit >= 0; bit-- {
			if (idx & (1 << bit)) != 0 {
				if isLon {
					minLon = (minLon + maxLon) / 2
				} else {
					minLat = (minLat + maxLat) / 2
				}
			} else {
				if isLon {
					maxLon = (minLon + maxLon) / 2
				} else {
					maxLat = (minLat + maxLat) / 2
				}
			}
			isLon = !isLon
		}
	}

	return [4]float64{minLon, minLat, maxLon, maxLat}
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}
