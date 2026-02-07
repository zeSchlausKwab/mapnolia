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
  relays: string[];
  maxZoom: number;
  diskQuota: number;
  hasKeypair: boolean;
  npub?: string;
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
  status: "pending" | "downloading" | "ready" | "error";
  error?: string;
  size?: number;
}

// MapLayer represents an output chunked layer configuration
export interface MapLayer {
  id: string;
  sourceId: string;
  title?: string;
  minZoom: number;
  maxZoom: number;
  precision: number;
  status: "pending" | "chunking" | "ready" | "error";
  error?: string;
}

export interface ChunkJob {
  sourceId: string;
  status: string;
  progress: number;
  error?: string;
  totalChunks: number;
  doneChunks: number;
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

export async function deleteSource(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sources/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete source");
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

// ============================================================================
// Downloads
// ============================================================================

export async function getDownloads(): Promise<DownloadedFile[]> {
  const res = await fetch(`${API_BASE}/downloads`);
  if (!res.ok) throw new Error("Failed to fetch downloads");
  return res.json();
}
