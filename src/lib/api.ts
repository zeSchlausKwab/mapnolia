// API client for blosmap backend

const API_BASE = "/api";

export interface ServerInfo {
  name: string;
  about: string;
  picture: string;
  baseURL: string;
  version: string;
  software: string;
}

export interface ChunkInfo {
  bbox: [number, number, number, number];
  file: string;
  maxZoom: number;
  size?: number;
}

export interface Chunks {
  [geohash: string]: ChunkInfo;
}

export interface Stats {
  chunkCount: number;
  diskUsage: number;
  diskQuota: number;
}

export interface Config {
  name: string;
  about: string;
  picture: string;
  baseURL: string;
  relays: string[];
  maxZoom: number;
  diskQuota: number;
  hasKeypair: boolean;
  npub?: string;
  adminPubkey?: string;
}

export async function getInfo(): Promise<ServerInfo> {
  const res = await fetch(`${API_BASE}/info`);
  if (!res.ok) throw new Error("Failed to fetch server info");
  return res.json();
}

export async function getChunks(): Promise<Chunks> {
  const res = await fetch(`${API_BASE}/chunks`);
  if (!res.ok) throw new Error("Failed to fetch chunks");
  return res.json();
}

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export async function getConfig(): Promise<Config> {
  const res = await fetch(`${API_BASE}/config`);
  if (!res.ok) throw new Error("Failed to fetch config");
  return res.json();
}

export async function updateConfig(updates: Partial<Config>): Promise<void> {
  const res = await fetch(`${API_BASE}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update config");
}

export async function addChunk(geohash: string): Promise<void> {
  const res = await fetch(`${API_BASE}/chunks/${geohash}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to add chunk");
}

export async function removeChunk(geohash: string): Promise<void> {
  const res = await fetch(`${API_BASE}/chunks/${geohash}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to remove chunk");
}

export async function generateKeypair(): Promise<{ npub: string }> {
  const res = await fetch(`${API_BASE}/keypair`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to generate keypair");
  return res.json();
}

export async function publishAnnouncement(): Promise<void> {
  const res = await fetch(`${API_BASE}/publish`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to publish announcement");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// ============================================================================
// Source Management
// ============================================================================

// Source represents an input PMTiles file
export interface Source {
  id: string;
  url: string;
  title?: string;
  status: "pending" | "fetching_metadata" | "downloading" | "ready" | "error";
  error?: string;
  size?: number;
  // Metadata from PMTiles header
  tileType?: string;
  tileCompression?: string;
  minZoom?: number;
  maxZoom?: number;
  bounds?: [number, number, number, number];
  center?: [number, number, number];
  // Extended metadata
  numTileEntries?: number;
  numContents?: number;
  clustered?: boolean;
  internalCompression?: string;
  attribution?: string;
  description?: string;
  vectorLayers?: string[];
}

// MapLayer represents an output layer configuration (chunked or file-based)
export interface MapLayer {
  id: string;
  sourceId: string;
  title?: string;
  minZoom: number;
  maxZoom: number;
  precision: number;
  maxChunkSize?: number;  // bytes; chunks exceeding this get subdivided (0 = disabled)
  maxPrecision?: number;  // max depth for recursive subdivision (default 4)
  status: "pending" | "chunking" | "ready" | "error";
  error?: string;
  chunks?: Chunks;
  file?: string;      // blob hash for file layers (uploaded via blossom)
  tileType?: string;  // from PMTiles header: mvt, png, jpg, etc.
  fileSize?: number;  // file size in bytes
}

export interface ChunkResult {
  geohash: string;
  file?: string;
  size?: number;
  status: "done" | "error" | "skipped";
  error?: string;
}

export interface ChunkProgress {
  geohash: string;
  percent: number;
  bytesInfo?: string;  // e.g. "(64 MB/152 MB, 4.2 MB/s)"
}

export interface ChunkJob {
  sourceId: string;
  status: string;
  progress: number;
  error?: string;
  totalChunks: number;
  doneChunks: number;
  currentTask?: string;
  currentChunk?: ChunkProgress;
  chunks?: ChunkResult[];
  subdivisions?: number;  // count of subdivision operations performed
}

export interface DownloadedFile {
  name: string;
  path: string;
  size: number;
  sha256: string;
  isRemote: boolean;
  sourceUrl?: string;
}

// ============================================================================
// Source Management
// ============================================================================

export async function getSources(): Promise<Source[]> {
  const res = await fetch(`${API_BASE}/sources`);
  if (!res.ok) throw new Error("Failed to fetch sources");
  return res.json();
}

export async function addSource(source: { id: string; url: string; title?: string }): Promise<Source> {
  const res = await fetch(`${API_BASE}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source),
  });
  if (!res.ok) throw new Error("Failed to add source");
  return res.json();
}

export async function updateSource(id: string, updates: { url?: string; title?: string }): Promise<Source> {
  const res = await fetch(`${API_BASE}/sources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update source");
  return res.json();
}

export async function deleteSource(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sources/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete source");
}

export async function refreshSourceMetadata(id: string): Promise<Source> {
  const res = await fetch(`${API_BASE}/sources/${id}/refresh`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to refresh metadata");
  return res.json();
}

// ============================================================================
// Layer Management
// ============================================================================

export async function getLayers(): Promise<MapLayer[]> {
  const res = await fetch(`${API_BASE}/layers`);
  if (!res.ok) throw new Error("Failed to fetch layers");
  return res.json();
}

export async function addLayer(layer: Omit<MapLayer, "status" | "error">): Promise<MapLayer> {
  const res = await fetch(`${API_BASE}/layers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(layer),
  });
  if (!res.ok) throw new Error("Failed to add layer");
  return res.json();
}

export async function deleteLayer(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/layers/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete layer");
}

export async function deleteLayerChunk(layerId: string, geohash: string): Promise<void> {
  const res = await fetch(`${API_BASE}/layers/${layerId}/chunks/${geohash}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete chunk");
}

export async function startLayerChunking(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/layers/${id}/chunk`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to start chunking");
}

export async function getLayerStatus(id: string): Promise<ChunkJob> {
  const res = await fetch(`${API_BASE}/layers/${id}/status`);
  if (!res.ok) throw new Error("Failed to get status");
  return res.json();
}

export async function retryChunk(layerId: string, geohash: string): Promise<void> {
  const res = await fetch(`${API_BASE}/layers/${layerId}/chunks/${geohash}/retry`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to retry chunk");
}

export async function retryLayerErrors(layerId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/layers/${layerId}/retry-errors`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to retry errors");
}

// ============================================================================
// Blossom Upload + File Layer
// ============================================================================

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

/** Upload a file via Blossom PUT /upload, returns the blob descriptor */
export function blossomUpload(
  file: File,
  onProgress?: (percent: number) => void
): Promise<BlobDescriptor> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/upload");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress((e.loaded / e.total) * 100);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(xhr.responseText || "Upload failed"));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

/** Register an uploaded blob as a file layer */
export async function addFileLayer(hash: string, id: string, title: string): Promise<MapLayer> {
  const res = await fetch(`${API_BASE}/layers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title, file: hash }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to add file layer");
  }
  return res.json();
}

// ============================================================================
// Announcement
// ============================================================================

export async function getAnnouncementPreview(): Promise<any> {
  const res = await fetch(`${API_BASE}/announcement/preview`);
  if (!res.ok) throw new Error("Failed to get announcement preview");
  return res.json();
}

// ============================================================================
// Downloads
// ============================================================================

export async function getDownloads(): Promise<DownloadedFile[]> {
  const res = await fetch(`${API_BASE}/downloads`);
  if (!res.ok) throw new Error("Failed to fetch downloads");
  return res.json();
}
