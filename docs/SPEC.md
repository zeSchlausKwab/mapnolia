# Maps on Blossom Protocol Specification

**Version:** 0.1.0
**Status:** Draft
**Date:** 2026-02-07

## Abstract

This document specifies a protocol for distributing map tiles (PMTiles format) via Blossom servers with Nostr-based discovery and announcements. It enables decentralized, censorship-resistant map hosting where anyone can run a map server and announce their available map data to the Nostr network.

## Table of Contents

1. [Overview](#overview)
2. [Components](#components)
3. [Event Specification: Kind 34444](#event-specification-kind-34444)
4. [Layer Types](#layer-types)
5. [Geohash Chunking](#geohash-chunking)
6. [Blossom Integration](#blossom-integration)
7. [Flows](#flows)
8. [WebTorrent Integration](#webtorrent-integration)
9. [Security Considerations](#security-considerations)
10. [Reference Implementation](#reference-implementation)

---

## Overview

Maps on Blossom combines three technologies:

1. **PMTiles** - Single-file tile archives that support HTTP Range requests for efficient streaming
2. **Blossom** - Content-addressed blob storage using SHA-256 hashes (BUD-01/02 compliant)
3. **Nostr** - Decentralized event publication for map layer announcements

This enables:
- Anyone to host map tiles from their own server
- Clients to discover available map sources via Nostr
- Efficient tile delivery using HTTP Range requests
- Content deduplication via SHA-256 addressing
- Optional P2P distribution via WebTorrent

---

## Components

### Blossom Server

A BUD-01/BUD-02 compliant server that:
- Stores PMTiles files named by their SHA-256 hash
- Serves blobs via `GET /<sha256>` with HTTP Range request support
- Supports upload via `PUT /upload` with Nostr authentication

### Nostr Relay Network

Used for:
- Publishing kind 34444 map layer announcements
- Discovering available map servers
- Authentication via kind 24242 events

### PMTiles

Cloud-optimized tile archives that:
- Store vector or raster tiles in a single file
- Support HTTP Range requests for partial reads
- Eliminate need for tile server infrastructure

---

## Event Specification: Kind 34444

### Event Kind

```
Kind: 34444
Type: Parameterized Replaceable Event (NIP-33)
Purpose: Announce map layers available from a Blossom server
```

The kind number 34444 was chosen to be:
- In the parameterized replaceable range (30000-39999)
- Memorable and map-related (latitude/longitude association)

### Event Structure

```json
{
  "kind": 34444,
  "pubkey": "<server_operator_pubkey_hex>",
  "created_at": <unix_timestamp>,
  "tags": [
    ["d", "<unique_server_identifier>"],
    ["name", "<server_display_name>"],
    ["about", "<server_description>"],
    ["picture", "<server_logo_url>"],
    ["r", "<relay_url_1>"],
    ["r", "<relay_url_2>"]
  ],
  "content": "<json_payload>",
  "sig": "<signature>"
}
```

### Tag Definitions

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | Unique identifier for this server (enables replaceable events) |
| `name` | Yes | Human-readable server name |
| `about` | No | Description of what maps are hosted |
| `picture` | No | URL to server logo/icon |
| `r` | No | Relay URLs where this event is published |

### Content Payload

The `content` field contains a JSON-encoded payload:

```json
{
  "layers": [
    {
      "id": "basemap",
      "title": "OpenStreetMap Basemap",
      "kind": "chunked-vector",
      "blossomServer": "https://blossom.example.com",
      "announcement": {
        "u": {
          "bbox": [-180, 0, -90, 90],
          "file": "abc123...def.pmtiles",
          "maxZoom": 14
        },
        "v": {
          "bbox": [-90, 0, 0, 90],
          "file": "789xyz...ghi.pmtiles",
          "maxZoom": 14
        }
      },
      "defaultEnabled": true,
      "defaultOpacity": 1.0
    }
  ]
}
```

### Payload Schema

```typescript
interface MapLayerSetPayload {
  layers: MapLayerDescriptor[];
}

type MapLayerDescriptor = ChunkedVectorLayer | PMTilesLayer;

interface ChunkedVectorLayer {
  id: string;
  title: string;
  kind: "chunked-vector";
  blossomServer: string;
  announcement: Record<string, ChunkInfo>;
  defaultEnabled?: boolean;
  defaultOpacity?: number;
}

interface PMTilesLayer {
  id: string;
  title: string;
  kind: "pmtiles";
  blossomServer: string;
  file: string;
  pmtilesType?: "raster" | "vector";
  defaultEnabled?: boolean;
  defaultOpacity?: number;
}

interface ChunkInfo {
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  file: string;                            // SHA-256 hash + .pmtiles extension
  maxZoom: number;                         // Maximum zoom level in chunk
}
```

---

## Layer Types

### chunked-vector

Used for world-scale basemaps split by geographic region.

**Characteristics:**
- World divided into geohash-based regions
- Each region stored as separate PMTiles file
- Supports mixed precision (some regions more detailed than others)
- Client uses longest-prefix matching to find correct chunk

**Use cases:**
- OpenStreetMap basemap
- Administrative boundaries
- Road networks

### pmtiles

Used for single-file overlays.

**Characteristics:**
- Entire layer in one PMTiles file
- Can be raster (satellite, terrain) or vector
- No geographic chunking needed

**Use cases:**
- Satellite imagery
- Terrain/hillshade
- Custom thematic overlays

---

## Geohash Chunking

### Geohash System

Geohash is a hierarchical spatial encoding that divides the world into 32 cells per precision level.

```
Base32 alphabet: 0123456789bcdefghjkmnpqrstuvwxyz
```

### Precision Levels

| Precision | Cells | Approximate Size | Typical Use |
|-----------|-------|------------------|-------------|
| 1 | 32 | 45° × 45° | Continental |
| 2 | 1,024 | 11° × 5.6° | Large countries |
| 3 | 32,768 | 1.4° × 1.4° | Small countries |
| 4 | 1,048,576 | 0.35° × 0.18° | Metro areas |

### Bounding Box Calculation

Each geohash maps to a bounding box:

```
geohash: "u" → bbox: [-180, 45, -135, 90]  // Example
```

The algorithm alternates longitude and latitude bits, then encodes to base32.

### Mixed Precision

Announcements can contain geohashes of different lengths:

```json
{
  "u": { ... },      // Precision 1: entire region as one chunk
  "v0": { ... },     // Precision 2: subdivided
  "v1": { ... },
  "vb": { ... }
}
```

Clients use **longest-prefix matching**: for a tile in geohash "v0k", check "v0k", then "v0", then "v".

### Content Addressing

Chunk files are named by SHA-256 hash of their content:

```
<sha256_hex>.pmtiles
```

This enables:
- Automatic deduplication (ocean tiles, empty areas)
- Cache-friendly URLs
- Content verification

---

## Blossom Integration

### Required BUD Compliance

| BUD | Specification | Required |
|-----|---------------|----------|
| BUD-01 | Get/Head Blobs | Yes |
| BUD-02 | Upload/Delete | Yes (for server operators) |

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/<sha256>` | Download PMTiles chunk |
| GET | `/<sha256>.pmtiles` | Download with extension hint |
| HEAD | `/<sha256>` | Check existence, get size |
| PUT | `/upload` | Upload chunk (authenticated) |
| DELETE | `/<sha256>` | Remove chunk (authenticated) |

### HTTP Range Requests

PMTiles relies on HTTP Range requests for efficient tile access. Servers MUST support:

```http
GET /<sha256>.pmtiles HTTP/1.1
Range: bytes=1024-2047
```

Response:
```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 1024-2047/1048576
Accept-Ranges: bytes
```

### CORS Headers

For browser clients, servers MUST include:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization, Range, *
Access-Control-Allow-Methods: GET, HEAD, PUT, DELETE, OPTIONS
Access-Control-Expose-Headers: Content-Range, Accept-Ranges
```

---

## Flows

### 1. Server Setup Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Operator configures server                               │
│    - Set name, about, picture                               │
│    - Configure relays                                       │
│    - Provide private key (nsec)                             │
├─────────────────────────────────────────────────────────────┤
│ 2. Download/configure basemap source                        │
│    - Download PMTiles from Protomaps or other source        │
│    - Or configure remote URL for on-demand extraction       │
├─────────────────────────────────────────────────────────────┤
│ 3. Extract geohash regions                                  │
│    - Select regions to host (e.g., "u", "v", "s")           │
│    - Run pmtiles extract for each region                    │
│    - Store chunks as <sha256>.pmtiles                       │
├─────────────────────────────────────────────────────────────┤
│ 4. Build and publish announcement                           │
│    - Construct kind 34444 event                             │
│    - Include all chunk mappings                             │
│    - Sign and publish to relays                             │
└─────────────────────────────────────────────────────────────┘
```

### 2. Client Discovery Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Subscribe to kind 34444 events                           │
│    - REQ: {"kinds": [34444], "limit": 50}                   │
│    - Optionally filter by trusted pubkeys                   │
├─────────────────────────────────────────────────────────────┤
│ 2. Parse announcements                                      │
│    - Extract layer list from content                        │
│    - Build combined announcement from multiple servers      │
├─────────────────────────────────────────────────────────────┤
│ 3. Configure map renderer                                   │
│    - Add sources for each layer                             │
│    - Set up tile URL template                               │
└─────────────────────────────────────────────────────────────┘
```

### 3. Tile Rendering Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Map requests tile at z/x/y                               │
├─────────────────────────────────────────────────────────────┤
│ 2. Calculate tile center coordinates                        │
│    lon = (x + 0.5) / 2^z * 360 - 180                        │
│    lat = atan(sinh(π * (1 - 2 * (y + 0.5) / 2^z))) * 180/π  │
├─────────────────────────────────────────────────────────────┤
│ 3. Convert to geohash at configured precision               │
│    geohash = encode(lon, lat, precision)                    │
├─────────────────────────────────────────────────────────────┤
│ 4. Longest-prefix match in announcement                     │
│    for len = precision; len >= 1; len--:                    │
│      prefix = geohash[0:len]                                │
│      if prefix in announcement: return announcement[prefix] │
├─────────────────────────────────────────────────────────────┤
│ 5. Fetch tile from PMTiles chunk                            │
│    url = blossomServer + "/" + chunkInfo.file               │
│    pmtiles.getZxy(url, z, x, y)                             │
└─────────────────────────────────────────────────────────────┘
```

### 4. Chunk Update Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Trigger: Operator adds/removes chunk via UI                 │
├─────────────────────────────────────────────────────────────┤
│ 1. Update local announcement.json                           │
│    - Add new chunk: geohash → {bbox, file, maxZoom}         │
│    - Or remove chunk: delete geohash entry                  │
├─────────────────────────────────────────────────────────────┤
│ 2. Rebuild kind 34444 event                                 │
│    - Increment created_at                                   │
│    - Update content with new layer data                     │
├─────────────────────────────────────────────────────────────┤
│ 3. Sign and publish to relays                               │
│    - Replaces previous event (same d-tag)                   │
├─────────────────────────────────────────────────────────────┤
│ 4. Clients receive update                                   │
│    - Subscription triggers on new event                     │
│    - Client updates local layer configuration               │
└─────────────────────────────────────────────────────────────┘
```

---

## WebTorrent Integration

*Status: Future enhancement*

### Concept

For large basemap files (100+ GB), WebTorrent enables:
- P2P distribution reducing server bandwidth
- Faster downloads from multiple seeders
- Resilience if original source goes offline

### Proposed Flow

```
1. Server creates .torrent for basemap
2. Include magnet link in announcement
3. Clients can download via WebTorrent
4. Clients seed to other clients
```

### Announcement Extension

```json
{
  "layers": [...],
  "basemapTorrent": {
    "magnetUri": "magnet:?xt=urn:btih:...",
    "sha256": "...",
    "size": 123456789
  }
}
```

---

## Security Considerations

### Event Authentication

- Kind 34444 events are signed by server operator
- Clients SHOULD filter by trusted pubkeys for security-critical applications
- Event signature MUST be verified before trusting content

### Upload Authentication

- Upload requires kind 24242 Nostr auth event
- Server SHOULD verify pubkey matches configured operators
- Expiration times prevent replay attacks

### Content Integrity

- PMTiles files are content-addressed by SHA-256
- Clients can verify downloaded content matches expected hash
- Corrupted or tampered files will fail hash verification

### Denial of Service

- Servers SHOULD implement rate limiting
- Disk quotas prevent storage exhaustion
- Large uploads can be rejected based on Content-Length

---

## Reference Implementation

### Server: blosmap

Go-based Blossom server with:
- BUD-01/02 compliance
- PMTiles chunking
- Kind 34444 publishing
- Web admin UI

Repository: (this project)

### Client: MapLibre + Custom Protocol

JavaScript/TypeScript implementation using:
- MapLibre GL JS for rendering
- Custom `pmworld://` protocol for chunk resolution
- nostr-tools for event subscription

Reference: `/Users/schlaus/workspace/earthly/src/features/geo-editor/components/Map.tsx`

---

## Appendix A: Geohash Reference

### Base32 Encoding

```
0  1  2  3  4  5  6  7  8  9
b  c  d  e  f  g  h  j  k  m
n  p  q  r  s  t  u  v  w  x
y  z
```

### Geohash to BBox Algorithm

```typescript
function geohashToBBox(geohash: string): BBox {
  let minLon = -180, maxLon = 180;
  let minLat = -90, maxLat = 90;
  let isLon = true;

  for (const char of geohash) {
    const idx = BASE32.indexOf(char);
    for (let bit = 4; bit >= 0; bit--) {
      const val = (idx >> bit) & 1;
      if (isLon) {
        const mid = (minLon + maxLon) / 2;
        if (val) minLon = mid;
        else maxLon = mid;
      } else {
        const mid = (minLat + maxLat) / 2;
        if (val) minLat = mid;
        else maxLat = mid;
      }
      isLon = !isLon;
    }
  }

  return [minLon, minLat, maxLon, maxLat];
}
```

---

## Appendix B: Example Events

### Full Kind 34444 Event

```json
{
  "kind": 34444,
  "pubkey": "a1b2c3d4e5f6...",
  "created_at": 1707300000,
  "tags": [
    ["d", "blosmap-a1b2c3"],
    ["name", "European Map Server"],
    ["about", "Hosting OpenStreetMap tiles for Europe"],
    ["picture", "https://example.com/logo.png"],
    ["r", "wss://relay.damus.io"],
    ["r", "wss://nos.lol"]
  ],
  "content": "{\"layers\":[{\"id\":\"basemap\",\"title\":\"OpenStreetMap\",\"kind\":\"chunked-vector\",\"blossomServer\":\"https://blossom.example.com\",\"announcement\":{\"u\":{\"bbox\":[-180,45,-135,90],\"file\":\"abc123.pmtiles\",\"maxZoom\":14}},\"defaultEnabled\":true}]}",
  "sig": "xyz789..."
}
```

### Kind 24242 Auth Event (Upload)

```json
{
  "kind": 24242,
  "pubkey": "a1b2c3d4e5f6...",
  "created_at": 1707300000,
  "content": "Upload map chunk",
  "tags": [
    ["t", "upload"],
    ["x", "abc123def456..."],
    ["expiration", "1707303600"]
  ],
  "sig": "..."
}
```
