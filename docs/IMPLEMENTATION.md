# blosmap Implementation Plan

## Overview

**blosmap** is a specialized Blossom server for hosting and sharing PMTiles map chunks via Nostr announcements.

See [SPEC.md](./SPEC.md) for the protocol specification.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     blosmap monorepo                         │
├────────────────────────────┬─────────────────────────────────┤
│      Go Backend            │      TypeScript Frontend        │
│      (Gin + go-nostr)      │      (Bun + Vite + React)       │
├────────────────────────────┼─────────────────────────────────┤
│ • Blossom server (BUD-01/02)│ • World map visualization      │
│ • PMTiles chunking          │ • Region/geohash selector      │
│ • Nostr event publishing    │ • Disk quota management        │
│ • REST API for UI           │ • Server config editor         │
│ • WebTorrent seeding        │ • Basemap download controls    │
└────────────────────────────┴─────────────────────────────────┘
```

---

## Project Structure

```
blosmap/
├── cmd/
│   └── blosmap/
│       └── main.go              # CLI entry point
├── internal/
│   ├── server/
│   │   ├── server.go            # HTTP server setup (Gin)
│   │   ├── blossom.go           # BUD-01/02 handlers
│   │   ├── api.go               # REST API for UI
│   │   └── middleware.go        # Auth, CORS, quota
│   ├── storage/
│   │   ├── interface.go         # BlobStore interface
│   │   ├── filesystem.go        # Local disk storage
│   │   └── pmtiles.go           # PMTiles handling
│   ├── chunker/
│   │   ├── chunker.go           # PMTiles extraction
│   │   └── geohash.go           # Geohash utilities
│   ├── nostr/
│   │   ├── client.go            # Relay connection
│   │   ├── announcement.go      # Kind 34444 events
│   │   └── auth.go              # Kind 24242 validation
│   ├── config/
│   │   └── config.go            # YAML/env config
│   └── hooks/
│       └── hooks.go             # Upload/delete hooks
├── ui/                          # TypeScript frontend
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── WorldMap.tsx
│   │   │   ├── GeohashSelector.tsx
│   │   │   ├── ChunkList.tsx
│   │   │   ├── DiskUsage.tsx
│   │   │   ├── ServerConfig.tsx
│   │   │   └── BasemapDownload.tsx
│   │   └── hooks/
│   │       └── useApi.ts
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── bin/                         # PMTiles CLI binaries
│   ├── pmtiles-mac-silicon
│   └── pmtiles-linux-amd64
├── blosmap.config.example.yaml
├── go.mod
├── go.sum
├── Dockerfile
└── README.md
```

---

## Phase 1: Go Backend Core

### 1.1 Project Setup

**Dependencies (go.mod):**

```go
module github.com/user/blosmap

go 1.22

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/nbd-wtf/go-nostr v0.30.0
    github.com/protomaps/go-pmtiles/pmtiles v1.0.0
    gopkg.in/yaml.v3 v3.0.1
)
```

### 1.2 Configuration

**File: `blosmap.config.yaml`**

```yaml
# Server settings
port: 3544
data_dir: ./data
disk_quota: 50GB

# Nostr identity
private_key: ${BLOSMAP_NSEC}
relays:
  - wss://relay.damus.io
  - wss://nos.lol

# Server metadata (for kind 34444)
name: My Map Server
about: Hosting maps for the community
picture: https://example.com/logo.png

# Basemap source
basemap:
  source: https://build.protomaps.com/20251222.pmtiles

# Chunking defaults
max_zoom: 14
```

**File: `internal/config/config.go`**

```go
package config

type Config struct {
    Port       int      `yaml:"port"`
    DataDir    string   `yaml:"data_dir"`
    DiskQuota  string   `yaml:"disk_quota"`
    PrivateKey string   `yaml:"private_key"`
    Relays     []string `yaml:"relays"`
    Name       string   `yaml:"name"`
    About      string   `yaml:"about"`
    Picture    string   `yaml:"picture"`
    Basemap    struct {
        Source string `yaml:"source"`
    } `yaml:"basemap"`
    MaxZoom int `yaml:"max_zoom"`
}

func Load(path string) (*Config, error) {
    // Load from YAML, expand env vars
}

func (c *Config) GetQuotaBytes() int64 {
    // Parse "50GB" to bytes
}

func (c *Config) GetPrivateKey() []byte {
    // Parse nsec or hex
}

func (c *Config) GetNpub() string {
    // Derive public key, encode as npub
}
```

### 1.3 Blossom Server

**File: `internal/server/blossom.go`**

Implements BUD-01/BUD-02 endpoints.

```go
package server

// GET /<sha256> - Download blob with range support
func (s *Server) handleDownload(c *gin.Context) {
    sha256 := c.Param("sha256")

    // Resolve blob (try extensions: .pmtiles, .json, etc)
    blob, err := s.storage.Resolve(c.Request.Context(), sha256)
    if err != nil {
        c.JSON(404, gin.H{"error": "not found"})
        return
    }

    // Handle range request
    rangeHeader := c.GetHeader("Range")
    if rangeHeader != "" {
        s.handleRangeRequest(c, blob, rangeHeader)
        return
    }

    // Full download
    c.DataFromReader(200, blob.Size, blob.ContentType, blob.Reader, nil)
}

// HEAD /<sha256> - Check existence
func (s *Server) handleHead(c *gin.Context) {
    sha256 := c.Param("sha256")
    exists, size := s.storage.Exists(c.Request.Context(), sha256)
    if !exists {
        c.Status(404)
        return
    }
    c.Header("Content-Length", strconv.FormatInt(size, 10))
    c.Header("Accept-Ranges", "bytes")
    c.Status(200)
}

// PUT /upload - Upload blob
func (s *Server) handleUpload(c *gin.Context) {
    // Validate auth event
    authEvent := s.validateAuth(c)
    if authEvent == nil {
        return
    }

    // Check quota
    if !s.quota.CanStore(c.Request.ContentLength) {
        c.JSON(413, gin.H{"error": "quota exceeded"})
        return
    }

    // Store blob
    sha256, size, err := s.storage.Upload(c.Request.Context(), c.Request.Body)
    if err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    // Trigger hooks
    s.hooks.OnUpload(sha256, size, authEvent.PubKey)

    c.JSON(200, gin.H{
        "sha256": sha256,
        "size":   size,
        "url":    fmt.Sprintf("%s/%s", s.publicURL, sha256),
    })
}

// DELETE /<sha256> - Delete blob
func (s *Server) handleDelete(c *gin.Context) {
    sha256 := c.Param("sha256")

    // Validate auth
    authEvent := s.validateAuth(c)
    if authEvent == nil {
        return
    }

    // Delete
    if err := s.storage.Delete(c.Request.Context(), sha256); err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    // Trigger hooks
    s.hooks.OnDelete(sha256, authEvent.PubKey)

    c.Status(200)
}
```

### 1.4 Storage Interface

**File: `internal/storage/interface.go`**

```go
package storage

type BlobStore interface {
    // Upload stores data and returns SHA-256 hash
    Upload(ctx context.Context, data io.Reader) (sha256 string, size int64, err error)

    // Resolve finds blob by hash (tries various extensions)
    Resolve(ctx context.Context, sha256 string) (*Blob, error)

    // Exists checks if blob exists
    Exists(ctx context.Context, sha256 string) (bool, int64)

    // Delete removes blob
    Delete(ctx context.Context, sha256 string) error

    // List returns all blobs
    List(ctx context.Context) ([]BlobInfo, error)

    // GetDiskUsage returns total bytes used
    GetDiskUsage(ctx context.Context) (int64, error)
}

type Blob struct {
    SHA256      string
    Size        int64
    ContentType string
    Reader      io.ReadSeeker
}

type BlobInfo struct {
    SHA256    string
    Size      int64
    Extension string
    ModTime   time.Time
}
```

**File: `internal/storage/filesystem.go`**

```go
package storage

type FilesystemStore struct {
    dataDir string
}

func (f *FilesystemStore) Upload(ctx context.Context, data io.Reader) (string, int64, error) {
    // Write to temp file while computing SHA-256
    // Move to final location as <sha256>.pmtiles
}

func (f *FilesystemStore) Resolve(ctx context.Context, sha256 string) (*Blob, error) {
    extensions := []string{"pmtiles", "json", "png", "jpg", "pdf"}
    for _, ext := range extensions {
        path := filepath.Join(f.dataDir, sha256+"."+ext)
        if info, err := os.Stat(path); err == nil {
            file, _ := os.Open(path)
            return &Blob{
                SHA256:      sha256,
                Size:        info.Size(),
                ContentType: mimeType(ext),
                Reader:      file,
            }, nil
        }
    }
    return nil, ErrNotFound
}
```

---

## Phase 2: PMTiles Chunking

### 2.1 Geohash Utilities

**File: `internal/chunker/geohash.go`**

Port from: `/Users/schlaus/workspace/earthly/map-scripts/geohashWorld.ts`

```go
package chunker

const Base32 = "0123456789bcdefghjkmnpqrstuvwxyz"

type BBox struct {
    MinLon, MinLat, MaxLon, MaxLat float64
}

// GeohashToBBox converts geohash string to bounding box
func GeohashToBBox(geohash string) BBox {
    minLon, maxLon := -180.0, 180.0
    minLat, maxLat := -90.0, 90.0
    isLon := true

    for _, char := range strings.ToLower(geohash) {
        idx := strings.IndexRune(Base32, char)
        if idx == -1 {
            continue
        }
        for bit := 4; bit >= 0; bit-- {
            val := (idx >> bit) & 1
            if isLon {
                mid := (minLon + maxLon) / 2
                if val == 1 {
                    minLon = mid
                } else {
                    maxLon = mid
                }
            } else {
                mid := (minLat + maxLat) / 2
                if val == 1 {
                    minLat = mid
                } else {
                    maxLat = mid
                }
            }
            isLon = !isLon
        }
    }
    return BBox{minLon, minLat, maxLon, maxLat}
}

// IterateWorldGeohashes generates all geohashes at given precision
func IterateWorldGeohashes(precision int) <-chan string {
    ch := make(chan string)
    go func() {
        defer close(ch)
        generate(ch, "", precision)
    }()
    return ch
}

func generate(ch chan<- string, prefix string, remaining int) {
    if remaining == 0 {
        ch <- prefix
        return
    }
    for _, c := range Base32 {
        generate(ch, prefix+string(c), remaining-1)
    }
}
```

### 2.2 PMTiles Chunker

**File: `internal/chunker/chunker.go`**

Port from: `/Users/schlaus/workspace/earthly/map-scripts/index.ts`

```go
package chunker

type Chunker struct {
    pmtilesBin string
    outputDir  string
    maxZoom    int
}

type ChunkResult struct {
    Geohash string
    SHA256  string
    Size    int64
    BBox    BBox
    MaxZoom int
}

func (c *Chunker) ExtractRegion(ctx context.Context, geohash, source string) (*ChunkResult, error) {
    bbox := GeohashToBBox(geohash)
    bboxStr := fmt.Sprintf("%f,%f,%f,%f", bbox.MinLon, bbox.MinLat, bbox.MaxLon, bbox.MaxLat)

    tmpFile := filepath.Join(c.outputDir, ".tmp", geohash+".pmtiles")

    // Run pmtiles extract
    cmd := exec.CommandContext(ctx, c.pmtilesBin,
        "extract", source, tmpFile,
        "--bbox="+bboxStr,
        "--minzoom=0",
        "--maxzoom="+strconv.Itoa(c.maxZoom),
    )

    if err := cmd.Run(); err != nil {
        return nil, fmt.Errorf("pmtiles extract failed: %w", err)
    }

    // Compute SHA-256
    sha256, err := hashFile(tmpFile)
    if err != nil {
        return nil, err
    }

    // Move to final location
    finalPath := filepath.Join(c.outputDir, sha256+".pmtiles")
    if err := os.Rename(tmpFile, finalPath); err != nil {
        return nil, err
    }

    info, _ := os.Stat(finalPath)

    return &ChunkResult{
        Geohash: geohash,
        SHA256:  sha256,
        Size:    info.Size(),
        BBox:    bbox,
        MaxZoom: c.maxZoom,
    }, nil
}

func (c *Chunker) SubdivideChunk(ctx context.Context, parentGeohash, sourceFile string) (map[string]*ChunkResult, error) {
    results := make(map[string]*ChunkResult)

    for _, char := range Base32 {
        childGeohash := parentGeohash + string(char)
        result, err := c.ExtractRegion(ctx, childGeohash, sourceFile)
        if err != nil {
            return nil, err
        }
        results[childGeohash] = result
    }

    return results, nil
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
```

---

## Phase 3: Nostr Integration

### 3.1 Nostr Client

**File: `internal/nostr/client.go`**

```go
package nostr

import (
    "github.com/nbd-wtf/go-nostr"
    "github.com/nbd-wtf/go-nostr/nip19"
)

type Client struct {
    privateKey string
    publicKey  string
    relays     []string
    pool       *nostr.SimplePool
}

func NewClient(privateKeyHexOrNsec string, relays []string) (*Client, error) {
    var sk string
    if strings.HasPrefix(privateKeyHexOrNsec, "nsec") {
        _, data, err := nip19.Decode(privateKeyHexOrNsec)
        if err != nil {
            return nil, err
        }
        sk = hex.EncodeToString(data.([]byte))
    } else {
        sk = privateKeyHexOrNsec
    }

    pk, _ := nostr.GetPublicKey(sk)

    return &Client{
        privateKey: sk,
        publicKey:  pk,
        relays:     relays,
        pool:       nostr.NewSimplePool(context.Background()),
    }, nil
}

func (c *Client) Publish(ctx context.Context, event *nostr.Event) error {
    event.Sign(c.privateKey)

    for _, url := range c.relays {
        relay, err := c.pool.EnsureRelay(url)
        if err != nil {
            continue
        }
        relay.Publish(ctx, *event)
    }
    return nil
}

func (c *Client) GetNpub() string {
    npub, _ := nip19.EncodePublicKey(c.publicKey)
    return npub
}
```

### 3.2 Announcement Manager

**File: `internal/nostr/announcement.go`**

```go
package nostr

const Kind34444 = 34444

type AnnouncementManager struct {
    client   *Client
    config   *config.Config
    dataDir  string
}

type ChunkInfo struct {
    BBox    [4]float64 `json:"bbox"`
    File    string     `json:"file"`
    MaxZoom int        `json:"maxZoom"`
}

type Layer struct {
    ID           string               `json:"id"`
    Title        string               `json:"title"`
    Kind         string               `json:"kind"`
    BlossomServer string              `json:"blossomServer"`
    Announcement map[string]ChunkInfo `json:"announcement,omitempty"`
    File         string               `json:"file,omitempty"`
    PMTilesType  string               `json:"pmtilesType,omitempty"`
}

type Payload struct {
    Layers []Layer `json:"layers"`
}

func (a *AnnouncementManager) BuildEvent() (*nostr.Event, error) {
    // Load announcement.json
    announcement, err := a.loadAnnouncement()
    if err != nil {
        return nil, err
    }

    payload := Payload{
        Layers: []Layer{{
            ID:            "basemap",
            Title:         "OpenStreetMap Basemap",
            Kind:          "chunked-vector",
            BlossomServer: a.config.PublicURL,
            Announcement:  announcement,
        }},
    }

    content, _ := json.Marshal(payload)

    event := &nostr.Event{
        Kind:      Kind34444,
        CreatedAt: nostr.Now(),
        Tags: nostr.Tags{
            {"d", "blosmap-" + a.client.publicKey[:8]},
            {"name", a.config.Name},
            {"about", a.config.About},
        },
        Content: string(content),
    }

    if a.config.Picture != "" {
        event.Tags = append(event.Tags, nostr.Tag{"picture", a.config.Picture})
    }

    for _, relay := range a.config.Relays {
        event.Tags = append(event.Tags, nostr.Tag{"r", relay})
    }

    return event, nil
}

func (a *AnnouncementManager) Publish(ctx context.Context) error {
    event, err := a.BuildEvent()
    if err != nil {
        return err
    }
    return a.client.Publish(ctx, event)
}

func (a *AnnouncementManager) UpdateChunk(geohash string, info *ChunkInfo) error {
    announcement, _ := a.loadAnnouncement()
    if info == nil {
        delete(announcement, geohash)
    } else {
        announcement[geohash] = *info
    }
    return a.saveAnnouncement(announcement)
}
```

---

## Phase 4: REST API

### 4.1 API Routes

**File: `internal/server/api.go`**

```go
package server

func (s *Server) registerAPIRoutes(r *gin.RouterGroup) {
    r.GET("/info", s.apiGetInfo)
    r.GET("/chunks", s.apiGetChunks)
    r.POST("/chunks/:geohash", s.apiAddChunk)
    r.DELETE("/chunks/:geohash", s.apiRemoveChunk)
    r.GET("/config", s.apiGetConfig)
    r.PATCH("/config", s.apiUpdateConfig)
    r.POST("/basemap/download", s.apiDownloadBasemap)
    r.GET("/basemap/status", s.apiBasemapStatus)
    r.GET("/stats", s.apiGetStats)
}

func (s *Server) apiGetInfo(c *gin.Context) {
    usage, _ := s.storage.GetDiskUsage(c.Request.Context())

    c.JSON(200, gin.H{
        "name":      s.config.Name,
        "about":     s.config.About,
        "picture":   s.config.Picture,
        "pubkey":    s.nostr.GetNpub(),
        "diskUsage": usage,
        "diskQuota": s.config.GetQuotaBytes(),
    })
}

func (s *Server) apiGetChunks(c *gin.Context) {
    announcement, _ := s.announcement.LoadAnnouncement()
    c.JSON(200, announcement)
}

func (s *Server) apiAddChunk(c *gin.Context) {
    geohash := c.Param("geohash")

    // Start extraction in background
    jobID := s.startChunkJob(geohash)

    c.JSON(202, gin.H{
        "status": "extracting",
        "jobId":  jobID,
    })
}

func (s *Server) apiRemoveChunk(c *gin.Context) {
    geohash := c.Param("geohash")

    // Update announcement
    s.announcement.UpdateChunk(geohash, nil)

    // Republish to Nostr
    s.announcement.Publish(c.Request.Context())

    c.JSON(200, gin.H{"status": "removed"})
}

func (s *Server) apiGetStats(c *gin.Context) {
    usage, _ := s.storage.GetDiskUsage(c.Request.Context())
    blobs, _ := s.storage.List(c.Request.Context())

    c.JSON(200, gin.H{
        "diskUsage":  usage,
        "diskQuota":  s.config.GetQuotaBytes(),
        "chunkCount": len(blobs),
    })
}
```

---

## Phase 5: TypeScript Frontend

### 5.1 Tech Stack

- **Build**: Vite
- **Framework**: React 18+
- **Map**: MapLibre GL JS
- **Styling**: Tailwind CSS
- **State**: React Query for API

### 5.2 Project Setup

```bash
cd ui
bun create vite . --template react-ts
bun add maplibre-gl @tanstack/react-query tailwindcss
```

### 5.3 Components

**WorldMap.tsx** - MapLibre showing hosted regions
```tsx
import maplibregl from 'maplibre-gl';

export function WorldMap({ chunks, onGeohashClick }) {
    // Render world map
    // Color geohash cells based on hosting status
    // Click to select/deselect
}
```

**GeohashSelector.tsx** - Region selection UI
```tsx
export function GeohashSelector({ onSelect }) {
    // Grid of geohash buttons
    // Precision selector
    // Visual feedback for selection
}
```

**DiskUsage.tsx** - Quota visualization
```tsx
export function DiskUsage({ used, quota }) {
    const percent = (used / quota) * 100;
    return (
        <div className="w-full bg-gray-200 rounded">
            <div
                className="bg-blue-500 h-4 rounded"
                style={{ width: `${percent}%` }}
            />
        </div>
    );
}
```

**ServerConfig.tsx** - Edit server metadata
```tsx
export function ServerConfig({ config, onSave }) {
    // Form for name, about, picture
    // Save triggers config update + republish
}
```

### 5.4 API Client

**hooks/useApi.ts**
```tsx
import { useQuery, useMutation } from '@tanstack/react-query';

export function useServerInfo() {
    return useQuery({
        queryKey: ['info'],
        queryFn: () => fetch('/api/info').then(r => r.json()),
    });
}

export function useChunks() {
    return useQuery({
        queryKey: ['chunks'],
        queryFn: () => fetch('/api/chunks').then(r => r.json()),
    });
}

export function useAddChunk() {
    return useMutation({
        mutationFn: (geohash: string) =>
            fetch(`/api/chunks/${geohash}`, { method: 'POST' }),
    });
}
```

---

## Phase 6: CLI Entry Point

### 6.1 Main

**File: `cmd/blosmap/main.go`**

```go
package main

import (
    "fmt"
    "os"

    "github.com/user/blosmap/internal/config"
    "github.com/user/blosmap/internal/server"
)

func main() {
    fmt.Println("🗺️  blosmap - PMTiles Blossom Server")

    // Load config
    cfg, err := config.Load("blosmap.config.yaml")
    if err != nil {
        fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
        os.Exit(1)
    }

    // Create and start server
    srv, err := server.New(cfg)
    if err != nil {
        fmt.Fprintf(os.Stderr, "Error creating server: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("🌸 Running at http://localhost:%d/\n", cfg.Port)
    fmt.Printf("📂 Data: %s\n", cfg.DataDir)
    fmt.Printf("🔑 Pubkey: %s\n", srv.GetNpub())
    fmt.Printf("📡 Relays: %v\n", cfg.Relays)

    if err := srv.Run(); err != nil {
        fmt.Fprintf(os.Stderr, "Server error: %v\n", err)
        os.Exit(1)
    }
}
```

### 6.2 Dockerfile

```dockerfile
# Build Go backend
FROM golang:1.22-alpine AS go-builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o blosmap ./cmd/blosmap

# Build frontend
FROM oven/bun:1 AS ui-builder
WORKDIR /app/ui
COPY ui/package.json ui/bun.lockb ./
RUN bun install
COPY ui ./
RUN bun run build

# Final image
FROM alpine:latest
RUN apk add --no-cache ca-certificates
COPY --from=go-builder /app/blosmap /usr/local/bin/
COPY --from=go-builder /app/bin /usr/local/bin/pmtiles
COPY --from=ui-builder /app/ui/dist /app/ui/dist
WORKDIR /app
EXPOSE 3544
ENTRYPOINT ["blosmap"]
```

---

## Implementation Order

| Phase | Description | Files |
|-------|-------------|-------|
| 1.1 | Project setup, go.mod | `go.mod`, `go.sum` |
| 1.2 | Config loading | `internal/config/config.go` |
| 1.3 | Blossom handlers | `internal/server/blossom.go` |
| 1.4 | Storage layer | `internal/storage/*.go` |
| 2.1 | Geohash utilities | `internal/chunker/geohash.go` |
| 2.2 | PMTiles chunker | `internal/chunker/chunker.go` |
| 3.1 | Nostr client | `internal/nostr/client.go` |
| 3.2 | Announcements | `internal/nostr/announcement.go` |
| 4 | REST API | `internal/server/api.go` |
| 5 | Frontend | `ui/src/**` |
| 6 | CLI + Docker | `cmd/blosmap/main.go`, `Dockerfile` |

---

## Code to Port from Earthly

| Source File | Destination | What to Port |
|-------------|-------------|--------------|
| `earthly/src/blossom.ts` | `internal/server/blossom.go` | HTTP handlers, range requests, CORS |
| `earthly/map-scripts/geohashWorld.ts` | `internal/chunker/geohash.go` | Geohash algorithms |
| `earthly/map-scripts/index.ts` | `internal/chunker/chunker.go` | PMTiles extraction |
| `earthly/src/lib/ndk/NDKMapLayerSetEvent.ts` | `internal/nostr/announcement.go` | Event structure |

---

## Testing

1. **Unit tests**: `go test ./...`
2. **Blossom compliance**: Use blossom-drive client
3. **PMTiles serving**: Verify with MapLibre
4. **Nostr events**: Check on nostr.band or similar
5. **UI**: Manual testing + Playwright
